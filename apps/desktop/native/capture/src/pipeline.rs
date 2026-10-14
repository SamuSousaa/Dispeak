//! The capture loop: one thread keeps the newest picture of the screen, converts it on every
//! tick of the frame rate and hands it to the encoder when the encoder asks for one.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use windows::core::Result;

use crate::capture::{Converter, Duplication, Gpu, Grab, find_output, output_size};
use crate::encoder::{Encoded, Encoder, Event, Settings};
use crate::preview::{self, Preview};

pub struct Options {
    pub adapter: u32,
    pub output: u32,
    pub max_width: u32,
    pub max_height: u32,
    pub frame_rate: u32,
    pub bitrate: u32,
    /// Local port the app listens on for the streamer's own preview.
    pub preview_port: Option<u16>,
}

/// Counters for one interval, reset by whoever reads them.
#[derive(Default, Clone)]
pub struct Counters {
    /// Ticks that had a picture the previous tick did not.
    pub fresh: u32,
    /// Ticks sent to the encoder.
    pub submitted: u32,
    /// Ticks lost because the encoder was still busy.
    pub encoder_busy: u32,
    /// Frames out of the encoder, and the bytes and time (push to output) they took.
    pub encoded: u32,
    pub key_frames: u32,
    pub bytes: u64,
    pub latency_total: Duration,
    pub need_input_events: u32,
    pub have_output_events: u32,
    pub max_pending: u32,
}

pub struct Pipeline {
    gpu: Gpu,
    duplication: Duplication,
    converter: Converter,
    encoder: Encoder,
    interval: Duration,
    next_tick: Instant,
    slot: usize,
    pending_input: u32,
    fresh_since_tick: bool,
    started: Instant,
    pushed: VecDeque<(i64, Instant)>,
    pub counters: Counters,
    pub size: (u32, u32),
    preview: Option<Preview>,
    /// Ticks between two preview pictures, and ticks so far.
    preview_every: u32,
    ticks: u32,
}

impl Pipeline {
    pub fn new(options: &Options) -> Result<Self> {
        let (adapter, output) = find_output(options.adapter, options.output)?;
        let gpu = Gpu::on_adapter(&adapter)?;
        let duplication = Duplication::new(&gpu, output)?;
        let screen = (duplication.width, duplication.height);
        let size = output_size(screen, (options.max_width, options.max_height));
        // Enough textures that the encoder never reads one being written.
        let converter = Converter::new(
            &gpu,
            &duplication.latest,
            screen,
            size,
            options.frame_rate,
            windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_NV12,
            8,
        )?;
        let encoder = Encoder::new(
            &gpu.device,
            gpu.luid,
            &Settings {
                width: size.0,
                height: size.1,
                frame_rate: options.frame_rate,
                bitrate: options.bitrate,
                // Key frames when asked; a periodic one only as a safety net.
                gop: options.frame_rate * 10,
            },
        )?;
        let preview = match options.preview_port {
            Some(port) => Preview::connect(&gpu, &duplication.latest, screen, port)?,
            None => None,
        };
        let interval = Duration::from_nanos(1_000_000_000 / options.frame_rate as u64);
        let now = Instant::now();
        Ok(Self {
            gpu,
            duplication,
            converter,
            encoder,
            interval,
            next_tick: now,
            slot: 0,
            pending_input: 0,
            fresh_since_tick: true,
            started: now,
            pushed: VecDeque::new(),
            counters: Counters::default(),
            size,
            preview,
            preview_every: (options.frame_rate / preview::FRAME_RATE).max(1),
            ticks: 0,
        })
    }

    pub fn encoder_name(&self) -> String {
        format!("{} ({})", self.encoder.name, self.gpu.adapter_name)
    }

    pub fn request_key_frame(&self) {
        self.encoder.request_key_frame();
    }

    pub fn set_bitrate(&self, bitrate: u32) {
        self.encoder.set_bitrate(bitrate);
    }

    /// Runs until the next encoded frame (or an error), doing whatever is due meanwhile.
    pub fn step(&mut self) -> Result<Option<Encoded>> {
        loop {
            while let Some(event) = self.encoder.poll_event()? {
                match event {
                    Event::NeedInput => {
                        self.pending_input += 1;
                        self.counters.need_input_events += 1;
                        self.counters.max_pending =
                            self.counters.max_pending.max(self.pending_input);
                    }
                    Event::HaveOutput => {
                        self.counters.have_output_events += 1;
                        if let Some(frame) = self.encoder.pull()? {
                            self.account(&frame);
                            return Ok(Some(frame));
                        }
                    }
                    Event::Other => {}
                }
            }

            let now = Instant::now();
            if now >= self.next_tick {
                self.tick(now)?;
                continue;
            }
            // Short waits, so the encoder's events are never left waiting long.
            let wait = (self.next_tick - now).min(Duration::from_millis(2));
            if let Grab::Fresh = self
                .duplication
                .grab(&self.gpu, wait.as_millis().max(1) as u32)?
            {
                self.fresh_since_tick = true;
            }
        }
    }

    fn tick(&mut self, now: Instant) -> Result<()> {
        self.ticks = self.ticks.wrapping_add(1);
        if self.ticks.is_multiple_of(self.preview_every)
            && let Some(preview) = &mut self.preview
        {
            // A preview that fails is dropped; the stream goes on.
            if preview.capture(&self.gpu).is_err() {
                self.preview = None;
            }
        }
        if self.pending_input > 0 {
            let texture = self.converter.convert(self.slot)?.clone();
            self.slot = (self.slot + 1) % self.converter.pool_size();
            let time = (now - self.started).as_nanos() as i64 / 100;
            self.encoder
                .push(&texture, time, self.interval.as_nanos() as i64 / 100)?;
            self.pending_input -= 1;
            self.pushed.push_back((time, now));
            if self.pushed.len() > 64 {
                self.pushed.pop_front();
            }
            self.counters.submitted += 1;
            if self.fresh_since_tick {
                self.counters.fresh += 1;
            }
            self.fresh_since_tick = false;
        } else {
            self.counters.encoder_busy += 1;
        }
        self.next_tick += self.interval;
        // Far behind (the machine stalled): start counting again from now.
        if now > self.next_tick + self.interval * 4 {
            self.next_tick = now + self.interval;
        }
        Ok(())
    }

    fn account(&mut self, frame: &Encoded) {
        self.counters.encoded += 1;
        self.counters.bytes += frame.data.len() as u64;
        if frame.key_frame {
            self.counters.key_frames += 1;
        }
        while let Some(&(time, at)) = self.pushed.front() {
            if time > frame.time {
                break;
            }
            self.pushed.pop_front();
            if time == frame.time {
                self.counters.latency_total += at.elapsed();
            }
        }
    }

    /// Converts the newest picture once and reports which colour convention came out.
    pub fn color_check(&mut self, bars: bool) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if let Grab::Fresh = self.duplication.grab(&self.gpu, 100)? {
                break;
            }
        }
        if bars {
            // Saturated colour bars instead of the screen: every convention gives clearly different numbers.
            let (w, h) = (
                self.duplication.width as usize,
                self.duplication.height as usize,
            );
            let colours: [[u8; 4]; 8] = [
                [255, 255, 255, 255],
                [0, 255, 255, 255],
                [255, 255, 0, 255],
                [0, 255, 0, 255],
                [255, 0, 255, 255],
                [0, 0, 255, 255],
                [255, 0, 0, 255],
                [40, 120, 200, 255],
            ];
            let mut pixels = vec![0u8; w * h * 4];
            for y in 0..h {
                for x in 0..w {
                    let c = colours[x * 8 / w];
                    pixels[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&c);
                }
            }
            unsafe {
                self.gpu.context.UpdateSubresource(
                    &self.duplication.latest,
                    0,
                    None,
                    pixels.as_ptr() as _,
                    (w * 4) as u32,
                    0,
                )
            };
        }
        let nv12 = self.converter.convert(0)?.clone();
        crate::colorcheck::report(&self.gpu, &self.duplication.latest, &nv12, self.size)
    }

    pub fn take_counters(&mut self) -> Counters {
        std::mem::take(&mut self.counters)
    }
}
