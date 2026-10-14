//! Checks what the video processor really wrote: reads one captured picture (BGRA) and its NV12
//! conversion back from the card and finds which YCbCr convention the numbers follow.

use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
use windows::core::Result;

use crate::capture::Gpu;

fn staging(gpu: &Gpu, source: &ID3D11Texture2D) -> Result<ID3D11Texture2D> {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { source.GetDesc(&mut desc) };
    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
    desc.MiscFlags = 0;
    desc.SampleDesc = DXGI_SAMPLE_DESC {
        Count: 1,
        Quality: 0,
    };
    let mut copy = None;
    unsafe {
        gpu.device.CreateTexture2D(&desc, None, Some(&mut copy))?;
        let copy = copy.as_ref().expect("staging texture");
        gpu.context.CopyResource(copy, source);
    }
    Ok(copy.expect("staging texture"))
}

fn read(gpu: &Gpu, texture: &ID3D11Texture2D, rows: usize) -> Result<(Vec<u8>, usize)> {
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe {
        gpu.context
            .Map(texture, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?
    };
    let pitch = mapped.RowPitch as usize;
    let bytes =
        unsafe { std::slice::from_raw_parts(mapped.pData as *const u8, pitch * rows) }.to_vec();
    unsafe { gpu.context.Unmap(texture, 0) };
    Ok((bytes, pitch))
}

/// Y, Cb, Cr (0–255) of a full-range RGB pixel under one convention.
fn ycbcr(r: f64, g: f64, b: f64, kr: f64, kb: f64, limited: bool) -> (f64, f64, f64) {
    let (r, g, b) = (r / 255.0, g / 255.0, b / 255.0);
    let y = kr * r + (1.0 - kr - kb) * g + kb * b;
    let cb = (b - y) / (2.0 * (1.0 - kb));
    let cr = (r - y) / (2.0 * (1.0 - kr));
    if limited {
        (16.0 + 219.0 * y, 128.0 + 224.0 * cb, 128.0 + 224.0 * cr)
    } else {
        (255.0 * y, 128.0 + 255.0 * cb, 128.0 + 255.0 * cr)
    }
}

/// Prints the mean error of each convention against what the card produced; the smallest wins.
pub fn report(
    gpu: &Gpu,
    bgra: &ID3D11Texture2D,
    nv12: &ID3D11Texture2D,
    (w, h): (u32, u32),
) -> Result<()> {
    let (w, h) = (w as usize, h as usize);
    let src = staging(gpu, bgra)?;
    let dst = staging(gpu, nv12)?;
    let (rgb, rgb_pitch) = read(gpu, &src, h)?;
    // NV12: the Y plane, then the interleaved CbCr plane at half height.
    let (yuv, yuv_pitch) = read(gpu, &dst, h + h / 2)?;

    let conventions = [
        ("bt709-limited", 0.2126, 0.0722, true),
        ("bt709-full", 0.2126, 0.0722, false),
        ("bt601-limited", 0.299, 0.114, true),
        ("bt601-full", 0.299, 0.114, false),
    ];
    let mut errors = [0.0f64; 4];
    let mut samples = 0usize;
    let mut chroma_spread = 0.0f64;
    for y in (0..h).step_by(7) {
        for x in (0..w).step_by(11) {
            let p = y * rgb_pitch + x * 4;
            let (b, g, r) = (rgb[p] as f64, rgb[p + 1] as f64, rgb[p + 2] as f64);
            let luma = yuv[y * yuv_pitch + x] as f64;
            let c = (h + y / 2) * yuv_pitch + (x & !1);
            let (cb, cr) = (yuv[c] as f64, yuv[c + 1] as f64);
            chroma_spread += (cb - 128.0).abs() + (cr - 128.0).abs();
            for (i, &(_, kr, kb, limited)) in conventions.iter().enumerate() {
                let (ey, ecb, ecr) = ycbcr(r, g, b, kr, kb, limited);
                errors[i] += (ey - luma).abs() + (ecb - cb).abs() + (ecr - cr).abs();
            }
            samples += 1;
        }
    }
    let mut parts = Vec::new();
    for (i, (name, ..)) in conventions.iter().enumerate() {
        parts.push(format!("\"{name}\":{:.2}", errors[i] / samples as f64));
    }
    println!(
        "{{\"type\":\"colorcheck\",\"samples\":{samples},\"meanChroma\":{:.1},\"error\":{{{}}}}}",
        chroma_spread / samples as f64,
        parts.join(",")
    );
    Ok(())
}
