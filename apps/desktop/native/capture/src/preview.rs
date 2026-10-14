//! A small picture of what is being shared, for the streamer's own screen: scaled down on the
//! card, read back a few times a second and written to a local socket the app listens on. It
//! costs no network and next to nothing on the card.

use std::io::Write;
use std::net::TcpStream;
use std::sync::mpsc::{SyncSender, TrySendError, sync_channel};

use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::core::Result;

use crate::capture::{Converter, Gpu, output_size};

/// Largest preview, and how many pictures a second it gets.
pub const MAX_SIZE: (u32, u32) = (640, 360);
pub const FRAME_RATE: u32 = 15;

/// One picture: width and height (u32, little endian), then the BGRA rows, tightly packed.
fn frame_bytes(width: u32, height: u32, rows: &[u8], pitch: usize) -> Vec<u8> {
    let row = width as usize * 4;
    let mut out = Vec::with_capacity(8 + row * height as usize);
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    for y in 0..height as usize {
        out.extend_from_slice(&rows[y * pitch..y * pitch + row]);
    }
    out
}

pub struct Preview {
    converter: Converter,
    staging: [ID3D11Texture2D; 2],
    size: (u32, u32),
    /// Which staging texture the last copy went to, if one is waiting to be read.
    pending: Option<usize>,
    next: usize,
    outbox: SyncSender<Vec<u8>>,
}

impl Preview {
    /// Connects to the app's preview socket; `None` when it is not there.
    pub fn connect(
        gpu: &Gpu,
        source: &ID3D11Texture2D,
        screen: (u32, u32),
        port: u16,
    ) -> Result<Option<Self>> {
        let Ok(mut socket) = TcpStream::connect(("127.0.0.1", port)) else {
            return Ok(None);
        };
        let _ = socket.set_nodelay(true);
        let size = output_size(screen, MAX_SIZE);
        let converter = Converter::new(
            gpu,
            source,
            screen,
            size,
            FRAME_RATE,
            DXGI_FORMAT_B8G8R8A8_UNORM,
            1,
        )?;
        let desc = D3D11_TEXTURE2D_DESC {
            Width: size.0,
            Height: size.1,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let make = || -> Result<ID3D11Texture2D> {
            let mut texture = None;
            unsafe {
                gpu.device
                    .CreateTexture2D(&desc, None, Some(&mut texture))?
            };
            Ok(texture.expect("staging texture"))
        };
        let staging = [make()?, make()?];
        // One picture in flight at most: a slow reader gets fewer pictures, never late ones.
        let (outbox, inbox) = sync_channel::<Vec<u8>>(1);
        std::thread::spawn(move || {
            while let Ok(frame) = inbox.recv() {
                if socket.write_all(&frame).is_err() {
                    break;
                }
            }
        });
        Ok(Some(Self {
            converter,
            staging,
            size,
            pending: None,
            next: 0,
            outbox,
        }))
    }

    /// Reads the picture copied last time (long done by now) and starts copying this one.
    pub fn capture(&mut self, gpu: &Gpu) -> Result<()> {
        if let Some(index) = self.pending.take() {
            let texture = &self.staging[index];
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            unsafe {
                gpu.context
                    .Map(texture, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?
            };
            let pitch = mapped.RowPitch as usize;
            let rows = unsafe {
                std::slice::from_raw_parts(mapped.pData as *const u8, pitch * self.size.1 as usize)
            };
            let frame = frame_bytes(self.size.0, self.size.1, rows, pitch);
            unsafe { gpu.context.Unmap(texture, 0) };
            match self.outbox.try_send(frame) {
                Ok(()) | Err(TrySendError::Full(_)) => {}
                // The app stopped listening: no more previews.
                Err(TrySendError::Disconnected(_)) => return Ok(()),
            }
        }
        let scaled = self.converter.convert(0)?.clone();
        unsafe { gpu.context.CopyResource(&self.staging[self.next], &scaled) };
        self.pending = Some(self.next);
        self.next = (self.next + 1) % 2;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_rows_without_their_padding() {
        // 2x2 picture with rows padded to 12 bytes.
        let rows = [
            1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0, 9, 10, 11, 12, 13, 14, 15, 16, 0, 0, 0, 0,
        ];
        let frame = frame_bytes(2, 2, &rows, 12);
        assert_eq!(&frame[..8], &[2, 0, 0, 0, 2, 0, 0, 0]);
        assert_eq!(
            &frame[8..],
            &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
        );
    }
}
