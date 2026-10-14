//! Sends the encoded frames to the media service's ingest and answers its RTCP: packets it lost
//! go again, key frames are made when asked for, and the bitrate follows the loss it reports.

use std::collections::VecDeque;
use std::net::{SocketAddr, UdpSocket};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::encoder::Encoded;
use crate::rtp::{self, Feedback};
use crate::srtp::Session;

/// Packets kept for retransmission: well over a second of a 1080p60 stream.
const HISTORY: usize = 2048;
/// Lowest bitrate the loss control goes down to.
const MIN_BITRATE: u32 = 1_000_000;

pub struct Target {
    pub address: SocketAddr,
    pub rtcp_address: SocketAddr,
    pub ssrc: u32,
    pub payload_type: u8,
}

/// What the sender tells the encoder to do.
pub enum Control {
    KeyFrame,
    Bitrate(u32),
}

pub enum Input {
    Frame(Encoded),
    Feedback(Vec<Feedback>),
}

/// Counters the stats line reads and resets.
#[derive(Default)]
pub struct Stats {
    pub frames: AtomicU32,
    pub bytes: AtomicU64,
    pub retransmitted: AtomicU32,
    pub key_frames_asked: AtomicU32,
    /// Latest loss reported by the server, out of 256.
    pub loss: AtomicU32,
    pub bitrate: AtomicU32,
    /// RTCP packets from the server, and those that did not verify.
    pub rtcp_received: AtomicU32,
    pub rtcp_rejected: AtomicU32,
}

struct LossControl {
    target: u32,
    current: u32,
    changed: Instant,
}

impl LossControl {
    /// GCC's loss-based rule: back off by half the loss above 10%, grow 8% a second under 2%.
    fn update(&mut self, fraction: u8, now: Instant) -> Option<u32> {
        if now - self.changed < Duration::from_secs(1) {
            return None;
        }
        let loss = fraction as f64 / 256.0;
        let next = if loss > 0.10 {
            (self.current as f64 * (1.0 - 0.5 * loss)) as u32
        } else if loss < 0.02 {
            (self.current as f64 * 1.08) as u32
        } else {
            self.current
        }
        .clamp(MIN_BITRATE.min(self.target), self.target);
        if next == self.current {
            return None;
        }
        self.current = next;
        self.changed = now;
        Some(next)
    }
}

/// Opens the two sockets (RTP, and RTCP both ways) and starts the RTCP reader.
/// `keys` are ours (what we encrypt with) and the server's (what its RTCP comes encrypted with).
pub fn connect(
    target: &Target,
    keys: (&[u8], &[u8]),
    input: Sender<Input>,
    stats: Arc<Stats>,
) -> std::io::Result<(UdpSocket, UdpSocket, Session)> {
    let any: SocketAddr = if target.address.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    }
    .parse()
    .expect("literal address");
    let rtp = UdpSocket::bind(any)?;
    let rtcp = UdpSocket::bind(any)?;
    let reader = rtcp.try_clone()?;
    let reader_session =
        Session::new(keys.1).ok_or_else(|| std::io::Error::other("bad SRTP key"))?;
    let session = Session::new(keys.0).ok_or_else(|| std::io::Error::other("bad SRTP key"))?;
    let ssrc = target.ssrc;
    std::thread::spawn(move || {
        let mut buffer = [0u8; 2048];
        while let Ok((length, _)) = reader.recv_from(&mut buffer) {
            stats.rtcp_received.fetch_add(1, Ordering::Relaxed);
            let Some(plain) = reader_session.unprotect_rtcp(&buffer[..length]) else {
                stats.rtcp_rejected.fetch_add(1, Ordering::Relaxed);
                continue;
            };
            let feedback = rtp::parse_feedback(&plain, ssrc);
            if !feedback.is_empty() && input.send(Input::Feedback(feedback)).is_err() {
                break;
            }
        }
    });
    Ok((rtp, rtcp, session))
}

pub fn run(
    target: Target,
    (rtp_socket, rtcp_socket, mut session): (UdpSocket, UdpSocket, Session),
    input: Receiver<Input>,
    control: Sender<Control>,
    stats: Arc<Stats>,
    bitrate: u32,
) {
    let mut seq: u16 = rand_u16();
    let timestamp_offset: u32 = (rand_u16() as u32) << 16 | rand_u16() as u32;
    let mut history: VecDeque<(u16, Vec<u8>)> = VecDeque::with_capacity(HISTORY);
    let mut loss = LossControl {
        target: bitrate,
        current: bitrate,
        changed: Instant::now(),
    };
    let mut last_report = Instant::now() - Duration::from_secs(10);
    let (mut packets_sent, mut octets_sent) = (0u32, 0u32);
    let mut last_timestamp = (timestamp_offset, Instant::now());
    let mut last_key_request = Instant::now() - Duration::from_secs(10);
    // The server counts a packet sent again as received, so its reports show no loss while the
    // network drops plenty. What it asks back for, out of what went out, is the real loss.
    let (mut window_sent, mut window_nacked) = (0u32, 0u32);
    stats.bitrate.store(bitrate, Ordering::Relaxed);

    let send = |socket: &UdpSocket, address: SocketAddr, packet: &[u8]| {
        let _ = socket.send_to(packet, address);
    };
    // Testing only: drops this share of first transmissions, as a bad network would. NACKs then
    // bring them back.
    let drop_share: f64 = std::env::var("DISPEAKER_CAPTURE_DROP")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.0);
    let mut dice: u32 = 0x1234_5678;

    loop {
        // A report a second; the first one right away teaches the server our RTCP address.
        if last_report.elapsed() >= Duration::from_secs(1) {
            last_report = Instant::now();
            let (base, at) = last_timestamp;
            let now_ts = base.wrapping_add((at.elapsed().as_micros() as u64 * 90 / 1000) as u32);
            let mut report =
                rtp::sender_report(target.ssrc, ntp_now(), now_ts, packets_sent, octets_sent);
            session.protect_rtcp(&mut report);
            send(&rtcp_socket, target.rtcp_address, &report);

            if window_sent > 0 {
                let fraction = ((window_nacked.min(window_sent) as u64 * 256) / window_sent as u64)
                    .min(255) as u8;
                stats.loss.store(fraction as u32, Ordering::Relaxed);
                if let Some(next) = loss.update(fraction, Instant::now()) {
                    stats.bitrate.store(next, Ordering::Relaxed);
                    let _ = control.send(Control::Bitrate(next));
                }
            }
            (window_sent, window_nacked) = (0, 0);
        }

        let message = match input.recv_timeout(Duration::from_millis(200)) {
            Ok(message) => message,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        match message {
            Input::Frame(frame) => {
                let timestamp =
                    timestamp_offset.wrapping_add((frame.time as u64 * 9 / 1000) as u32);
                last_timestamp = (timestamp, Instant::now());
                let payloads = rtp::payloads(&frame.data);
                let count = payloads.len();
                // Spread over a few milliseconds instead of all at once: a key frame is a
                // hundred packets, and a burst that size gets dropped on the way.
                let pace = pacing(loss.current);
                let started = Instant::now();
                let mut sent_bytes = 0usize;
                for (n, payload) in payloads.into_iter().enumerate() {
                    let mut packet = rtp::header(
                        target.payload_type,
                        n + 1 == count,
                        seq,
                        timestamp,
                        target.ssrc,
                    )
                    .to_vec();
                    packet.extend_from_slice(&payload);
                    session.protect_rtp(&mut packet);
                    dice = dice.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    if drop_share == 0.0 || (dice >> 8) as f64 / 16_777_216.0 >= drop_share {
                        send(&rtp_socket, target.address, &packet);
                    }
                    sent_bytes += packet.len();
                    if history.len() == HISTORY {
                        history.pop_front();
                    }
                    history.push_back((seq, packet));
                    seq = seq.wrapping_add(1);
                    packets_sent = packets_sent.wrapping_add(1);
                    window_sent += 1;
                    let due = Duration::from_secs_f64(sent_bytes as f64 / pace);
                    let elapsed = started.elapsed();
                    if due > elapsed + Duration::from_millis(1) {
                        std::thread::sleep(due - elapsed);
                    }
                }
                octets_sent = octets_sent.wrapping_add(sent_bytes as u32);
                stats.frames.fetch_add(1, Ordering::Relaxed);
                stats.bytes.fetch_add(sent_bytes as u64, Ordering::Relaxed);
            }
            Input::Feedback(items) => {
                for item in items {
                    match item {
                        Feedback::Nack(lost) => {
                            window_nacked += lost.len() as u32;
                            for wanted in lost {
                                if let Some((_, packet)) =
                                    history.iter().rev().find(|(s, _)| *s == wanted)
                                {
                                    send(&rtp_socket, target.address, packet);
                                    stats.retransmitted.fetch_add(1, Ordering::Relaxed);
                                }
                            }
                        }
                        Feedback::KeyFrame => {
                            stats.key_frames_asked.fetch_add(1, Ordering::Relaxed);
                            // Several viewers joining at once ask together: one key frame does.
                            if last_key_request.elapsed() >= Duration::from_millis(300) {
                                last_key_request = Instant::now();
                                let _ = control.send(Control::KeyFrame);
                            }
                        }
                        // Loss after retransmissions: what is left even after asking again.
                        Feedback::Loss(fraction) => {
                            if fraction > 25
                                && let Some(next) = loss.update(fraction, Instant::now())
                            {
                                stats.bitrate.store(next, Ordering::Relaxed);
                                let _ = control.send(Control::Bitrate(next));
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Bytes per second packets go out at: well above the bitrate, so a frame still leaves within
/// a few milliseconds, but never as one burst.
fn pacing(bitrate: u32) -> f64 {
    (bitrate as f64 * 4.0).max(20_000_000.0) / 8.0
}

fn ntp_now() -> u64 {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = since.as_secs() + 2_208_988_800;
    let fraction = ((since.subsec_nanos() as u64) << 32) / 1_000_000_000;
    (seconds << 32) | fraction
}

fn rand_u16() -> u16 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    let mixed = nanos.wrapping_mul(0x9e37_79b9) ^ std::process::id().rotate_left(16);
    (mixed >> 8) as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backs_off_on_heavy_loss_and_recovers_slowly() {
        let start = Instant::now();
        let mut control = LossControl {
            target: 8_000_000,
            current: 8_000_000,
            changed: start,
        };
        // Too soon after the last change.
        assert_eq!(control.update(64, start), None);
        // 25% loss: down by 12.5%.
        assert_eq!(
            control.update(64, start + Duration::from_secs(1)),
            Some(7_000_000)
        );
        // Moderate loss holds.
        assert_eq!(control.update(10, start + Duration::from_secs(2)), None);
        // Clean: up 8%, never above the target.
        assert_eq!(
            control.update(0, start + Duration::from_secs(3)),
            Some(7_560_000)
        );
        assert_eq!(
            control.update(0, start + Duration::from_secs(4)),
            Some(8_000_000)
        );
        assert_eq!(control.update(0, start + Duration::from_secs(5)), None);
    }
}
