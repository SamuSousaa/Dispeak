//! SRTP and SRTCP with AES_CM_128_HMAC_SHA1_80 (RFC 3711), the suite the media service's ingest
//! uses. One master key serves both directions: what we send, and the RTCP the server sends back.

use aes::cipher::{KeyIvInit, StreamCipher};
use hmac::{Hmac, Mac};
use sha1::Sha1;

type Aes128Ctr = ctr::Ctr128BE<aes::Aes128>;
type HmacSha1 = Hmac<Sha1>;

const TAG_LEN: usize = 10;

struct Keys {
    cipher: [u8; 16],
    salt: [u8; 14],
    auth: [u8; 20],
}

/// RFC 3711 §4.3.1, with a key derivation rate of zero.
fn derive(master_key: &[u8; 16], master_salt: &[u8; 14], label: u8, out: &mut [u8]) {
    let mut iv = [0u8; 16];
    iv[..14].copy_from_slice(master_salt);
    // key_id = label || index DIV kdr (zero), XORed into the salt from its seventh byte.
    iv[7] ^= label;
    out.fill(0);
    Aes128Ctr::new(master_key.into(), &iv.into()).apply_keystream(out);
}

fn keys(master_key: &[u8; 16], master_salt: &[u8; 14], first_label: u8) -> Keys {
    let mut keys = Keys {
        cipher: [0; 16],
        salt: [0; 14],
        auth: [0; 20],
    };
    derive(master_key, master_salt, first_label, &mut keys.cipher);
    derive(master_key, master_salt, first_label + 1, &mut keys.auth);
    derive(master_key, master_salt, first_label + 2, &mut keys.salt);
    keys
}

/// The counter block of AES-CM: salt, SSRC and packet index in their places.
fn counter(salt: &[u8; 14], ssrc: u32, index: u64) -> [u8; 16] {
    let mut iv = [0u8; 16];
    iv[..14].copy_from_slice(salt);
    for (i, byte) in ssrc.to_be_bytes().iter().enumerate() {
        iv[4 + i] ^= byte;
    }
    for (i, byte) in index.to_be_bytes()[2..].iter().enumerate() {
        iv[8 + i] ^= byte;
    }
    iv
}

fn tag(key: &[u8; 20], parts: &[&[u8]]) -> [u8; TAG_LEN] {
    let mut mac = HmacSha1::new_from_slice(key).expect("HMAC takes any key length");
    for part in parts {
        mac.update(part);
    }
    let full = mac.finalize().into_bytes();
    let mut out = [0u8; TAG_LEN];
    out.copy_from_slice(&full[..TAG_LEN]);
    out
}

pub struct Session {
    rtp: Keys,
    rtcp: Keys,
    /// Rollover counter of our RTP sequence numbers.
    roc: u32,
    last_seq: Option<u16>,
    rtcp_index: u32,
}

impl Session {
    /// `master` is the 30 bytes the server handed out: 16 of key, then 14 of salt.
    pub fn new(master: &[u8]) -> Option<Self> {
        if master.len() != 30 {
            return None;
        }
        let key: [u8; 16] = master[..16].try_into().ok()?;
        let salt: [u8; 14] = master[16..].try_into().ok()?;
        Some(Self {
            rtp: keys(&key, &salt, 0),
            rtcp: keys(&key, &salt, 3),
            roc: 0,
            last_seq: None,
            rtcp_index: 0,
        })
    }

    /// Encrypts an RTP packet of ours (12-byte header, no CSRCs or extensions) and appends its tag.
    pub fn protect_rtp(&mut self, packet: &mut Vec<u8>) {
        let seq = u16::from_be_bytes([packet[2], packet[3]]);
        let ssrc = u32::from_be_bytes([packet[8], packet[9], packet[10], packet[11]]);
        if let Some(last) = self.last_seq
            && seq < last
            && last - seq > 0x8000
        {
            self.roc = self.roc.wrapping_add(1);
        }
        if self
            .last_seq
            .is_none_or(|last| seq.wrapping_sub(last) < 0x8000)
        {
            self.last_seq = Some(seq);
        }
        let index = ((self.roc as u64) << 16) | seq as u64;
        let iv = counter(&self.rtp.salt, ssrc, index);
        Aes128Ctr::new(&self.rtp.cipher.into(), &iv.into()).apply_keystream(&mut packet[12..]);
        let tag = tag(&self.rtp.auth, &[packet, &self.roc.to_be_bytes()]);
        packet.extend_from_slice(&tag);
    }

    /// Encrypts an RTCP compound packet of ours and appends the SRTCP index and tag.
    pub fn protect_rtcp(&mut self, packet: &mut Vec<u8>) {
        let ssrc = u32::from_be_bytes([packet[4], packet[5], packet[6], packet[7]]);
        let index = self.rtcp_index & 0x7fff_ffff;
        self.rtcp_index = self.rtcp_index.wrapping_add(1);
        let iv = counter(&self.rtcp.salt, ssrc, index as u64);
        Aes128Ctr::new(&self.rtcp.cipher.into(), &iv.into()).apply_keystream(&mut packet[8..]);
        packet.extend_from_slice(&(0x8000_0000 | index).to_be_bytes());
        let tag = tag(&self.rtcp.auth, &[packet]);
        packet.extend_from_slice(&tag);
    }

    /// Checks and decrypts an SRTCP packet from the server; `None` when it does not verify.
    pub fn unprotect_rtcp(&self, packet: &[u8]) -> Option<Vec<u8>> {
        if packet.len() < 8 + 4 + TAG_LEN {
            return None;
        }
        let (body, received) = packet.split_at(packet.len() - TAG_LEN);
        if tag(&self.rtcp.auth, &[body]) != received {
            return None;
        }
        let (rtcp, trailer) = body.split_at(body.len() - 4);
        let e_index = u32::from_be_bytes(trailer.try_into().ok()?);
        let mut plain = rtcp.to_vec();
        if e_index & 0x8000_0000 != 0 {
            let ssrc = u32::from_be_bytes([plain[4], plain[5], plain[6], plain[7]]);
            let iv = counter(&self.rtcp.salt, ssrc, (e_index & 0x7fff_ffff) as u64);
            Aes128Ctr::new(&self.rtcp.cipher.into(), &iv.into()).apply_keystream(&mut plain[8..]);
        }
        Some(plain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn derives_the_session_keys_of_rfc_3711_appendix_b3() {
        let key: [u8; 16] = hex("E1F97A0D3E018BE0D64FA32C06DE4139").try_into().unwrap();
        let salt: [u8; 14] = hex("0EC675AD498AFEEBB6960B3AABE6").try_into().unwrap();
        let derived = keys(&key, &salt, 0);
        assert_eq!(
            derived.cipher.to_vec(),
            hex("C61E7A93744F39EE10734AFE3FF7A087")
        );
        assert_eq!(derived.salt.to_vec(), hex("30CBBC08863D8C85D49DB34A9AE1"));
        assert_eq!(
            derived.auth.to_vec(),
            hex("CEBE321F6FF7716B6FD4AB49AF256A156D38BAA4")
        );
    }

    #[test]
    fn srtcp_round_trips_and_rejects_tampering() {
        let master: Vec<u8> = (0..30).collect();
        let mut sender = Session::new(&master).unwrap();
        let receiver = Session::new(&master).unwrap();
        // A receiver report from SSRC 0x01020304 with no blocks, plus some payload.
        let original = vec![0x81, 201, 0, 1, 1, 2, 3, 4, 9, 9, 9, 9];
        let mut packet = original.clone();
        sender.protect_rtcp(&mut packet);
        assert_ne!(&packet[8..12], &original[8..12]);
        assert_eq!(receiver.unprotect_rtcp(&packet).unwrap(), original);
        let last = packet.len() - 1;
        packet[last] ^= 1;
        assert!(receiver.unprotect_rtcp(&packet).is_none());
    }

    #[test]
    fn counts_rollovers_of_the_sequence_number() {
        let mut session = Session::new(&[7u8; 30]).unwrap();
        for seq in [65534u16, 65535, 0, 1] {
            let mut packet = vec![
                0x80,
                96,
                (seq >> 8) as u8,
                seq as u8,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                1,
                42,
            ];
            session.protect_rtp(&mut packet);
        }
        assert_eq!(session.roc, 1);
    }
}
