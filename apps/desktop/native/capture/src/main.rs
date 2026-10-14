//! dispeaker-capture: the desktop app's own screen capture. Grabs a monitor, encodes it to
//! H.264 on the graphics card and sends it to an ingest of the media service. See
//! docs/adr/0013-motor-de-transmissao-nativo.md.

mod capture;
mod colorcheck;
mod encoder;
mod pipeline;
mod rtp;
mod sender;
mod srtp;

use std::io::BufRead;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::Ordering;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use base64::Engine;
use pipeline::{Options, Pipeline};
use sender::{Control, Input, Stats, Target};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};

fn arg(args: &[String], name: &str, default: u32) -> u32 {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn options(args: &[String]) -> Options {
    Options {
        adapter: arg(args, "--adapter", 0),
        output: arg(args, "--output", 0),
        max_width: arg(args, "--width", 1920),
        max_height: arg(args, "--height", 1080),
        frame_rate: arg(args, "--fps", 60),
        bitrate: arg(args, "--bitrate", 8_000_000),
    }
}

/// Encodes for a while without sending anything and prints what it measured, once a second.
fn bench(args: &[String]) -> windows::core::Result<()> {
    let seconds = arg(args, "--seconds", 10);
    let mut pipeline = Pipeline::new(&options(args))?;
    println!(
        "{{\"type\":\"ready\",\"encoder\":{:?},\"width\":{},\"height\":{}}}",
        pipeline.encoder_name(),
        pipeline.size.0,
        pipeline.size.1
    );
    let end = Instant::now() + Duration::from_secs(seconds as u64);
    let mut last = Instant::now();
    let mut first_key = true;
    while Instant::now() < end {
        if let Some(frame) = pipeline.step()?
            && frame.key_frame
            && first_key
        {
            first_key = false;
            let types: Vec<u8> = nal_types(&frame.data);
            println!(
                "{{\"type\":\"key-frame\",\"nals\":{:?},\"bytes\":{}}}",
                types,
                frame.data.len()
            );
        }
        if last.elapsed() >= Duration::from_secs(1) {
            let seconds = last.elapsed().as_secs_f64();
            last = Instant::now();
            let c = pipeline.take_counters();
            let latency = if c.encoded > 0 {
                c.latency_total.as_secs_f64() * 1000.0 / c.encoded as f64
            } else {
                0.0
            };
            println!(
                "{{\"type\":\"stats\",\"fresh\":{:.1},\"submitted\":{:.1},\"encoded\":{:.1},\"encoderBusy\":{},\"encodeMs\":{:.1},\"kbps\":{:.0},\"keyFrames\":{}}}",
                c.fresh as f64 / seconds,
                c.submitted as f64 / seconds,
                c.encoded as f64 / seconds,
                c.encoder_busy,
                latency,
                c.bytes as f64 * 8.0 / seconds / 1000.0,
                c.key_frames
            );
        }
    }
    Ok(())
}

fn text_arg<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

/// Sends to an ingest until stdin closes (the app quit or stopped the share). The first two lines
/// of stdin are SRTP master keys in base64, ours and the server's: they never show on a command
/// line.
fn stream(args: &[String]) -> Result<(), String> {
    let address: IpAddr = text_arg(args, "--address")
        .ok_or("--address missing")?
        .parse()
        .map_err(|_| "bad --address")?;
    let rtp_port = arg(args, "--rtp-port", 0) as u16;
    let rtcp_port = arg(args, "--rtcp-port", 0) as u16;
    let ssrc = arg(args, "--ssrc", 0);
    if rtp_port == 0 || rtcp_port == 0 || ssrc == 0 {
        return Err("--rtp-port, --rtcp-port and --ssrc are required".into());
    }
    let read_key = || -> Result<Vec<u8>, String> {
        let mut line = String::new();
        std::io::stdin()
            .lock()
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        base64::engine::general_purpose::STANDARD
            .decode(line.trim())
            .map_err(|_| "bad SRTP key".into())
    };
    let key = read_key()?;
    let server_key = read_key()?;

    let options = options(args);
    let mut pipeline = Pipeline::new(&options).map_err(|e| e.to_string())?;
    let target = Target {
        address: SocketAddr::new(address, rtp_port),
        rtcp_address: SocketAddr::new(address, rtcp_port),
        ssrc,
        payload_type: arg(args, "--pt", 96) as u8,
    };
    let (input_tx, input_rx) = mpsc::channel();
    let (control_tx, control_rx) = mpsc::channel();
    let stats = Arc::new(Stats::default());
    let sockets = sender::connect(
        &target,
        (&key, &server_key),
        input_tx.clone(),
        stats.clone(),
    )
    .map_err(|e| e.to_string())?;
    {
        let stats = stats.clone();
        let bitrate = options.bitrate;
        std::thread::spawn(move || {
            sender::run(target, sockets, input_rx, control_tx, stats, bitrate)
        });
    }
    // The app closes our stdin to stop us, and so does its death.
    std::thread::spawn(|| {
        let mut sink = String::new();
        while std::io::stdin()
            .lock()
            .read_line(&mut sink)
            .map(|n| n > 0)
            .unwrap_or(false)
        {
            sink.clear();
        }
        std::process::exit(0);
    });

    println!(
        "{{\"type\":\"ready\",\"encoder\":{:?},\"width\":{},\"height\":{}}}",
        pipeline.encoder_name(),
        pipeline.size.0,
        pipeline.size.1
    );
    let encoder = pipeline.encoder_name();
    // Diagnostics: the stats lines again on stderr, which the app writes to its log.
    let debug = std::env::var_os("DISPEAKER_CAPTURE_DEBUG").is_some();
    let mut last = Instant::now();
    loop {
        while let Ok(control) = control_rx.try_recv() {
            match control {
                Control::KeyFrame => {
                    if debug {
                        eprintln!("key frame asked");
                    }
                    pipeline.request_key_frame()
                }
                Control::Bitrate(bitrate) => pipeline.set_bitrate(bitrate),
            }
        }
        if let Some(frame) = pipeline.step().map_err(|e| e.to_string())?
            && input_tx.send(Input::Frame(frame)).is_err()
        {
            return Err("sender stopped".into());
        }
        if last.elapsed() >= Duration::from_secs(2) {
            let seconds = last.elapsed().as_secs_f64();
            last = Instant::now();
            let c = pipeline.take_counters();
            let frames = stats.frames.swap(0, Ordering::Relaxed);
            let bytes = stats.bytes.swap(0, Ordering::Relaxed);
            let encode_ms = if c.encoded > 0 {
                c.latency_total.as_secs_f64() * 1000.0 / c.encoded as f64
            } else {
                0.0
            };
            let line = format!(
                "{{\"type\":\"stats\",\"captureFps\":{:.1},\"sentFps\":{:.1},\"encodeMs\":{:.1},\"kbps\":{:.0},\"width\":{},\"height\":{},\"bitrate\":{},\"retransmitted\":{},\"keyFramesAsked\":{},\"lossPercent\":{:.1},\"encoderBusy\":{},\"keyFrames\":{},\"encoder\":{:?}}}",
                c.fresh as f64 / seconds,
                frames as f64 / seconds,
                encode_ms,
                bytes as f64 * 8.0 / seconds / 1000.0,
                pipeline.size.0,
                pipeline.size.1,
                stats.bitrate.load(Ordering::Relaxed),
                stats.retransmitted.swap(0, Ordering::Relaxed),
                stats.key_frames_asked.swap(0, Ordering::Relaxed),
                stats.loss.load(Ordering::Relaxed) as f64 * 100.0 / 256.0,
                c.encoder_busy,
                c.key_frames,
                encoder
            );
            println!("{line}");
            if debug {
                eprintln!(
                    "{line} rtcp={} rejected={}",
                    stats.rtcp_received.swap(0, Ordering::Relaxed),
                    stats.rtcp_rejected.swap(0, Ordering::Relaxed)
                );
            }
        }
    }
}

/// Whether this machine can run the capture: a hardware H.264 encoder on the first card.
fn probe(args: &[String]) -> Result<(), String> {
    let pipeline = Pipeline::new(&options(args)).map_err(|e| e.to_string())?;
    println!(
        "{{\"type\":\"probe\",\"codec\":\"h264\",\"encoder\":{:?}}}",
        pipeline.encoder_name()
    );
    Ok(())
}

/// NAL unit types in an Annex B buffer, in order.
fn nal_types(data: &[u8]) -> Vec<u8> {
    let mut types = Vec::new();
    let mut i = 0;
    while i + 3 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            types.push(data[i + 3] & 0x1f);
            i += 3;
        } else {
            i += 1;
        }
    }
    types
}

/// Windows 11 throttles a process with no visible window after a few seconds: it ignores the
/// timer resolution asked for and wakes it on the 15.6 ms tick. The encoder's own waits then take
/// two ticks per frame (31 fps). Opting out of execution-speed throttling and of the timer
/// resolution being ignored keeps 60 fps. Same fix as the app's (windows-scheduling.ts).
fn keep_timers_fine() {
    use windows::Win32::System::Threading::{
        GetCurrentProcess, PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        PROCESS_POWER_THROTTLING_EXECUTION_SPEED, PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION,
        PROCESS_POWER_THROTTLING_STATE, ProcessPowerThrottling, SetProcessInformation,
    };
    let state = PROCESS_POWER_THROTTLING_STATE {
        Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED
            | PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION,
        StateMask: 0,
    };
    unsafe {
        let _ = SetProcessInformation(
            GetCurrentProcess(),
            ProcessPowerThrottling,
            &state as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        );
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        // Waits of a millisecond or two must last that long, not a whole 15.6 ms tick.
        windows::Win32::Media::timeBeginPeriod(1);
    }
    keep_timers_fine();
    if let Err(error) = encoder::startup() {
        eprintln!("media foundation: {error}");
        std::process::exit(2);
    }
    let result = match args.get(1).map(String::as_str) {
        Some("bench") => bench(&args).map_err(|e| e.to_string()),
        Some("stream") => stream(&args),
        Some("probe") => probe(&args),
        // Diagnostics: the screen at its own size, so pixels line up one to one.
        Some("colorcheck") => {
            let mut options = options(&args);
            (options.max_width, options.max_height) = (16_384, 16_384);
            Pipeline::new(&options)
                .and_then(|mut pipeline| pipeline.color_check(args.iter().any(|a| a == "--bars")))
                .map_err(|e| e.to_string())
        }
        _ => {
            eprintln!(
                "usage: dispeaker-capture stream|probe|bench [--adapter N] [--output N] [--width 1920] [--height 1080] [--fps 60] [--bitrate 8000000]
                 stream also takes --address A --rtp-port P --rtcp-port Q --ssrc S [--pt 96], and the SRTP key on stdin"
            );
            std::process::exit(64);
        }
    };
    if let Err(error) = result {
        println!("{{\"type\":\"error\",\"message\":{:?}}}", error);
        std::process::exit(1);
    }
}
