//! Desktop Duplication of one monitor and the conversion of its frames to NV12, both on the
//! graphics card the monitor is plugged into. Nothing here touches system memory.

use std::mem::ManuallyDrop;

use windows::Win32::Foundation::{HMODULE, LUID, RECT};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::core::{Interface, Result};

/// The card and the context everything runs on. The device is shared with the encoder through
/// Media Foundation, so it is protected for use from several threads.
pub struct Gpu {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub luid: LUID,
    pub adapter_name: String,
}

impl Gpu {
    pub fn on_adapter(adapter: &IDXGIAdapter1) -> Result<Self> {
        let mut device = None;
        let mut context = None;
        unsafe {
            D3D11CreateDevice(
                adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )?;
        }
        let device: ID3D11Device = device.expect("D3D11CreateDevice succeeded without a device");
        let context = context.expect("D3D11CreateDevice succeeded without a context");
        let multithread: ID3D11Multithread = device.cast()?;
        unsafe {
            let _ = multithread.SetMultithreadProtected(true);
        }
        // A game takes the whole card; without priority the capture's work waits behind its
        // frames. The highest value (7) is what OBS asks for.
        if let Ok(dxgi) = device.cast::<IDXGIDevice>() {
            unsafe {
                let _ = dxgi.SetGPUThreadPriority(7);
            }
        }
        let desc = unsafe { adapter.GetDesc1()? };
        let name_len = desc
            .Description
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(desc.Description.len());
        Ok(Self {
            device,
            context,
            luid: desc.AdapterLuid,
            adapter_name: String::from_utf16_lossy(&desc.Description[..name_len]),
        })
    }

    pub fn texture(
        &self,
        width: u32,
        height: u32,
        format: DXGI_FORMAT,
        bind: D3D11_BIND_FLAG,
    ) -> Result<ID3D11Texture2D> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: bind.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut texture = None;
        unsafe {
            self.device
                .CreateTexture2D(&desc, None, Some(&mut texture))?
        };
        Ok(texture.expect("CreateTexture2D succeeded without a texture"))
    }
}

/// The adapter and output (`ddagrab`'s numbering: by card, then by output).
pub fn find_output(adapter_index: u32, output_index: u32) -> Result<(IDXGIAdapter1, IDXGIOutput1)> {
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };
    let adapter = unsafe { factory.EnumAdapters1(adapter_index)? };
    let output: IDXGIOutput1 = unsafe { adapter.EnumOutputs(output_index)?.cast()? };
    Ok((adapter, output))
}

pub enum Grab {
    /// A new picture is in the copy.
    Fresh,
    /// The screen did not change within the wait.
    Unchanged,
}

/// Desktop Duplication of one output, keeping a copy of the newest picture.
pub struct Duplication {
    output: IDXGIOutput1,
    duplication: IDXGIOutputDuplication,
    pub width: u32,
    pub height: u32,
    /// The newest captured picture, BGRA, ready for the video processor.
    pub latest: ID3D11Texture2D,
}

impl Duplication {
    pub fn new(gpu: &Gpu, output: IDXGIOutput1) -> Result<Self> {
        let duplication = unsafe { output.DuplicateOutput(&gpu.device)? };
        let desc = unsafe { duplication.GetDesc() };
        let (width, height) = (desc.ModeDesc.Width, desc.ModeDesc.Height);
        let latest = gpu.texture(
            width,
            height,
            DXGI_FORMAT_B8G8R8A8_UNORM,
            D3D11_BIND_RENDER_TARGET,
        )?;
        Ok(Self {
            output,
            duplication,
            width,
            height,
            latest,
        })
    }

    /// Waits up to `timeout_ms` for the screen to change and copies the new picture.
    pub fn grab(&mut self, gpu: &Gpu, timeout_ms: u32) -> Result<Grab> {
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;
        match unsafe {
            self.duplication
                .AcquireNextFrame(timeout_ms, &mut info, &mut resource)
        } {
            Ok(()) => {}
            Err(error) if error.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(Grab::Unchanged),
            Err(error) if error.code() == DXGI_ERROR_ACCESS_LOST => {
                // A mode change, a full-screen game taking over, the secure desktop: start over.
                self.duplication = unsafe { self.output.DuplicateOutput(&gpu.device)? };
                return Ok(Grab::Unchanged);
            }
            Err(error) => return Err(error),
        }
        // Only the mouse moved: the picture is the same.
        let fresh = info.LastPresentTime != 0;
        if fresh && let Some(resource) = resource {
            let texture: ID3D11Texture2D = resource.cast()?;
            unsafe { gpu.context.CopyResource(&self.latest, &texture) };
        }
        unsafe { self.duplication.ReleaseFrame()? };
        Ok(if fresh { Grab::Fresh } else { Grab::Unchanged })
    }
}

/// BGRA → NV12 (BT.709, limited range) with scaling, by the card's video processor.
pub struct Converter {
    context: ID3D11DeviceContext,
    video_context: ID3D11VideoContext,
    processor: ID3D11VideoProcessor,
    input: ID3D11VideoProcessorInputView,
    outputs: Vec<(ID3D11Texture2D, ID3D11VideoProcessorOutputView)>,
}

impl Converter {
    pub fn new(
        gpu: &Gpu,
        source: &ID3D11Texture2D,
        (in_w, in_h): (u32, u32),
        (out_w, out_h): (u32, u32),
        frame_rate: u32,
        pool: usize,
    ) -> Result<Self> {
        let video_device: ID3D11VideoDevice = gpu.device.cast()?;
        let video_context: ID3D11VideoContext = gpu.context.cast()?;
        let rate = DXGI_RATIONAL {
            Numerator: frame_rate,
            Denominator: 1,
        };
        let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: rate,
            InputWidth: in_w,
            InputHeight: in_h,
            OutputFrameRate: rate,
            OutputWidth: out_w,
            OutputHeight: out_h,
            Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
        };
        let enumerator = unsafe { video_device.CreateVideoProcessorEnumerator(&content)? };
        let processor = unsafe { video_device.CreateVideoProcessor(&enumerator, 0)? };

        let input_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPIV {
                    MipSlice: 0,
                    ArraySlice: 0,
                },
            },
        };
        let mut input = None;
        unsafe {
            video_device.CreateVideoProcessorInputView(
                source,
                &enumerator,
                &input_desc,
                Some(&mut input),
            )?
        };
        let input = input.expect("input view");

        let output_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
            },
        };
        let mut outputs = Vec::with_capacity(pool);
        for _ in 0..pool {
            let texture = gpu.texture(out_w, out_h, DXGI_FORMAT_NV12, D3D11_BIND_RENDER_TARGET)?;
            let mut view = None;
            unsafe {
                video_device.CreateVideoProcessorOutputView(
                    &texture,
                    &enumerator,
                    &output_desc,
                    Some(&mut view),
                )?
            };
            outputs.push((texture, view.expect("output view")));
        }

        // Bit fields of D3D11_VIDEO_PROCESSOR_COLOR_SPACE: RGB full range in, and out YCbCr with
        // the BT.709 matrix (bit 2) and studio range 16–235 (value 1 in bits 4–5).
        let rgb_full = D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: 0 };
        let yuv_709_limited = D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
            _bitfield: 0b01_0100,
        };
        // Letterboxed when the shapes differ: the whole screen is kept.
        let target = fit((in_w, in_h), (out_w, out_h));
        unsafe {
            video_context.VideoProcessorSetStreamColorSpace(&processor, 0, &rgb_full);
            video_context.VideoProcessorSetOutputColorSpace(&processor, &yuv_709_limited);
            video_context.VideoProcessorSetStreamFrameFormat(
                &processor,
                0,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );
            video_context.VideoProcessorSetStreamSourceRect(
                &processor,
                0,
                true,
                Some(&RECT {
                    left: 0,
                    top: 0,
                    right: in_w as i32,
                    bottom: in_h as i32,
                }),
            );
            video_context.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&target));
            video_context.VideoProcessorSetOutputTargetRect(
                &processor,
                true,
                Some(&RECT {
                    left: 0,
                    top: 0,
                    right: out_w as i32,
                    bottom: out_h as i32,
                }),
            );
            // Without this some drivers run the processor's "enhancements" over the picture.
            video_context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
        }
        Ok(Self {
            context: gpu.context.clone(),
            video_context,
            processor,
            input,
            outputs,
        })
    }

    /// Converts the source into the pooled texture `slot` and returns it.
    pub fn convert(&self, slot: usize) -> Result<&ID3D11Texture2D> {
        let (texture, view) = &self.outputs[slot % self.outputs.len()];
        let stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            OutputIndex: 0,
            InputFrameOrField: 0,
            PastFrames: 0,
            FutureFrames: 0,
            ppPastSurfaces: std::ptr::null_mut(),
            pInputSurface: ManuallyDrop::new(Some(self.input.clone())),
            ppFutureSurfaces: std::ptr::null_mut(),
            ppPastSurfacesRight: std::ptr::null_mut(),
            pInputSurfaceRight: ManuallyDrop::new(None),
            ppFutureSurfacesRight: std::ptr::null_mut(),
        };
        let mut streams = [stream];
        let result = unsafe {
            self.video_context
                .VideoProcessorBlt(&self.processor, view, 0, &streams)
        };
        // The stream holds a reference of its own to the input view.
        unsafe { ManuallyDrop::drop(&mut streams[0].pInputSurface) };
        result?;
        // Sent to the card now: the encoder is about to wait for this picture.
        unsafe { self.context.Flush() };
        Ok(texture)
    }

    pub fn pool_size(&self) -> usize {
        self.outputs.len()
    }
}

/// The largest rectangle of the source's shape inside `out`, centred, on even pixels.
fn fit((in_w, in_h): (u32, u32), (out_w, out_h): (u32, u32)) -> RECT {
    let scale = f64::min(out_w as f64 / in_w as f64, out_h as f64 / in_h as f64);
    let w = ((in_w as f64 * scale) as i32) & !1;
    let h = ((in_h as f64 * scale) as i32) & !1;
    let left = ((out_w as i32 - w) / 2) & !1;
    let top = ((out_h as i32 - h) / 2) & !1;
    RECT {
        left,
        top,
        right: left + w,
        bottom: top + h,
    }
}

/// The output size for a stream of at most `max` from a screen of `screen`: the screen's shape,
/// never larger than the screen, on even pixels (the encoder works in 2×2 blocks).
pub fn output_size(screen: (u32, u32), max: (u32, u32)) -> (u32, u32) {
    let scale = f64::min(
        1.0,
        f64::min(
            max.0 as f64 / screen.0 as f64,
            max.1 as f64 / screen.1 as f64,
        ),
    );
    (
        ((screen.0 as f64 * scale) as u32) & !1,
        ((screen.1 as f64 * scale) as u32) & !1,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_screen_shape_within_the_preset() {
        assert_eq!(output_size((2560, 1440), (1920, 1080)), (1920, 1080));
        assert_eq!(output_size((1920, 1080), (2560, 1440)), (1920, 1080));
        assert_eq!(output_size((3440, 1440), (1920, 1080)), (1920, 802));
        assert_eq!(output_size((1920, 1082), (1920, 1080)), (1916, 1080));
    }

    #[test]
    fn letterboxes_a_different_shape() {
        let r = fit((1920, 1080), (1920, 1200));
        assert_eq!((r.left, r.top, r.right, r.bottom), (0, 60, 1920, 1140));
    }
}
