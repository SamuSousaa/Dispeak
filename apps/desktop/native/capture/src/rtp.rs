//! H.264 over RTP (RFC 6184, packetization mode 1) and the RTCP the sender reads and writes.

/// Payload bytes per packet; with the headers and the SRTP tag a packet stays under 1250 bytes.
pub const MAX_PAYLOAD: usize = 1200;

/// NAL units of an Annex B buffer, without their start codes.
pub fn nal_units(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 2 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut units = Vec::with_capacity(starts.len());
    for (n, &start) in starts.iter().enumerate() {
        let mut end = starts.get(n + 1).map_or(data.len(), |&next| next - 3);
        // A four-byte start code leaves a zero at the end of the unit before it.
        while end > start && data[end - 1] == 0 && n + 1 < starts.len() {
            end -= 1;
        }
        if end > start {
            units.push(&data[start..end]);
        }
    }
    units
}

/// The RTP payloads of one frame: whole NAL units, or FU-A fragments of the big ones. Access
/// unit delimiters and filler say nothing a receiver needs and are left out.
pub fn payloads(frame: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    for unit in nal_units(frame) {
        let kind = unit[0] & 0x1f;
        if kind == 9 || kind == 12 {
            continue;
        }
        if unit.len() <= MAX_PAYLOAD {
            out.push(unit.to_vec());
            continue;
        }
        let indicator = (unit[0] & 0xe0) | 28;
        let body = &unit[1..];
        let chunks: Vec<&[u8]> = body.chunks(MAX_PAYLOAD - 2).collect();
        let last = chunks.len() - 1;
        for (n, chunk) in chunks.into_iter().enumerate() {
            let mut header = kind;
            if n == 0 {
                header |= 0x80;
            }
            if n == last {
                header |= 0x40;
            }
            let mut payload = Vec::with_capacity(chunk.len() + 2);
            payload.push(indicator);
            payload.push(header);
            payload.extend_from_slice(chunk);
            out.push(payload);
        }
    }
    out
}

pub fn header(payload_type: u8, marker: bool, seq: u16, timestamp: u32, ssrc: u32) -> [u8; 12] {
    let mut h = [0u8; 12];
    h[0] = 0x80;
    h[1] = payload_type | if marker { 0x80 } else { 0 };
    h[2..4].copy_from_slice(&seq.to_be_bytes());
    h[4..8].copy_from_slice(&timestamp.to_be_bytes());
    h[8..12].copy_from_slice(&ssrc.to_be_bytes());
    h
}

/// A sender report: lets the server line our clock up, and teaches it where our RTCP comes from.
pub fn sender_report(
    ssrc: u32,
    ntp: u64,
    rtp_timestamp: u32,
    packets: u32,
    octets: u32,
) -> Vec<u8> {
    let mut p = Vec::with_capacity(28);
    p.extend_from_slice(&[0x80, 200, 0, 6]);
    p.extend_from_slice(&ssrc.to_be_bytes());
    p.extend_from_slice(&ntp.to_be_bytes());
    p.extend_from_slice(&rtp_timestamp.to_be_bytes());
    p.extend_from_slice(&packets.to_be_bytes());
    p.extend_from_slice(&octets.to_be_bytes());
    p
}

#[derive(Debug, PartialEq)]
pub enum Feedback {
    /// Someone needs a key frame (PLI or FIR).
    KeyFrame,
    /// Sequence numbers to send again.
    Nack(Vec<u16>),
    /// Share of our packets lost since the last report, out of 256.
    Loss(u8),
}

/// What the server asks of us in one (decrypted) compound RTCP packet.
pub fn parse_feedback(mut data: &[u8], our_ssrc: u32) -> Vec<Feedback> {
    let mut out = Vec::new();
    while data.len() >= 4 {
        let format = data[0] & 0x1f;
        let kind = data[1];
        let length = (u16::from_be_bytes([data[2], data[3]]) as usize + 1) * 4;
        if length > data.len() {
            break;
        }
        let packet = &data[..length];
        let media_ssrc = |at: usize| {
            packet
                .get(at..at + 4)
                .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
        };
        match (kind, format) {
            // Receiver report (or a sender report's blocks): one block per stream it receives.
            (200 | 201, count) => {
                let first = if kind == 200 { 28 } else { 8 };
                for block in 0..count as usize {
                    let at = first + block * 24;
                    if media_ssrc(at) == Some(our_ssrc)
                        && let Some(&fraction) = packet.get(at + 4)
                    {
                        out.push(Feedback::Loss(fraction));
                    }
                }
            }
            (205, 1) if media_ssrc(8) == Some(our_ssrc) => {
                let mut lost = Vec::new();
                for fci in packet[12..].as_chunks::<4>().0 {
                    let pid = u16::from_be_bytes([fci[0], fci[1]]);
                    let mask = u16::from_be_bytes([fci[2], fci[3]]);
                    lost.push(pid);
                    for bit in 0..16 {
                        if mask & (1 << bit) != 0 {
                            lost.push(pid.wrapping_add(bit + 1));
                        }
                    }
                }
                out.push(Feedback::Nack(lost));
            }
            (206, 1) if media_ssrc(8) == Some(our_ssrc) => out.push(Feedback::KeyFrame),
            // FIR names the stream inside its entries, not in the header.
            (206, 4) if media_ssrc(12) == Some(our_ssrc) => out.push(Feedback::KeyFrame),
            _ => {}
        }
        data = &data[length..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_annex_b_with_both_start_code_lengths() {
        let data = [
            0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 5,
        ];
        assert_eq!(
            nal_units(&data),
            vec![&[0x67, 1, 2][..], &[0x68, 3][..], &[0x65, 4, 5][..]]
        );
    }

    #[test]
    fn fragments_big_units_and_drops_delimiters() {
        let mut frame = vec![0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x65];
        frame.extend(std::iter::repeat(7u8).take(3000));
        let packets = payloads(&frame);
        assert_eq!(packets.len(), 3);
        assert_eq!(packets[0][..2], [0x7c, 0x85]);
        assert_eq!(packets[1][..2], [0x7c, 0x05]);
        assert_eq!(packets[2][..2], [0x7c, 0x45]);
        let carried: usize = packets.iter().map(|p| p.len() - 2).sum();
        assert_eq!(carried, 3000);
    }

    #[test]
    fn reads_nack_pli_and_loss_for_our_stream_only() {
        let ours = 0x0a0b0c0d_u32.to_be_bytes();
        let theirs = 0x01010101_u32.to_be_bytes();
        let mut rtcp = vec![0x81, 201, 0, 7, 9, 9, 9, 9];
        rtcp.extend_from_slice(&ours);
        rtcp.extend_from_slice(&[26, 0, 0, 3]);
        rtcp.extend_from_slice(&[0; 16]);
        rtcp.extend_from_slice(&[0x81, 205, 0, 3, 9, 9, 9, 9]);
        rtcp.extend_from_slice(&ours);
        rtcp.extend_from_slice(&[0, 100, 0b0000_0000, 0b0000_0101]);
        rtcp.extend_from_slice(&[0x81, 206, 0, 2, 9, 9, 9, 9]);
        rtcp.extend_from_slice(&ours);
        rtcp.extend_from_slice(&[0x81, 206, 0, 2, 9, 9, 9, 9]);
        rtcp.extend_from_slice(&theirs);
        assert_eq!(
            parse_feedback(&rtcp, 0x0a0b0c0d),
            vec![
                Feedback::Loss(26),
                Feedback::Nack(vec![100, 101, 103]),
                Feedback::KeyFrame
            ]
        );
    }
}
