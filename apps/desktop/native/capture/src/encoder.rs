//! H.264 through Media Foundation: the graphics card's own encoder, whichever brand it is,
//! fed with NV12 textures straight from the card. Hardware encoders are asynchronous: they say
//! when they want a frame (`METransformNeedInput`) and when one is ready (`METransformHaveOutput`).

use std::mem::ManuallyDrop;

use windows::Win32::Foundation::{E_FAIL, LUID};
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::core::VARIANT;
use windows::core::{Interface, PWSTR, Result};

pub struct Settings {
    pub width: u32,
    pub height: u32,
    pub frame_rate: u32,
    pub bitrate: u32,
    /// Frames between two key frames, when nobody asks for one sooner.
    pub gop: u32,
}

/// One encoded frame, as Annex B (start codes before each NAL unit).
pub struct Encoded {
    pub data: Vec<u8>,
    /// 100 ns units, as given with the input.
    pub time: i64,
    pub key_frame: bool,
}

pub enum Event {
    NeedInput,
    HaveOutput,
    Other,
}

pub struct Encoder {
    transform: IMFTransform,
    events: IMFMediaEventGenerator,
    codec: ICodecAPI,
    /// Kept alive for as long as the encoder uses the device.
    _manager: IMFDXGIDeviceManager,
    provides_samples: bool,
    output_size: u32,
    pub name: String,
}

fn ratio(high: u32, low: u32) -> u64 {
    ((high as u64) << 32) | low as u64
}

fn friendly_name(activate: &IMFActivate) -> String {
    let mut name = PWSTR::null();
    let mut length = 0;
    unsafe {
        if activate
            .GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut length)
            .is_ok()
        {
            let text = name.to_string().unwrap_or_default();
            CoTaskMemFree(Some(name.0 as _));
            return text;
        }
    }
    String::from("H.264")
}

/// The hardware H.264 encoders of the card with this LUID, best first.
fn hardware_encoders(luid: LUID) -> Result<Vec<IMFActivate>> {
    let input = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_NV12,
    };
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
    };
    let mut attributes = None;
    unsafe { MFCreateAttributes(&mut attributes, 1)? };
    let attributes = attributes.expect("attributes");
    let luid_bytes: [u8; 8] = unsafe { std::mem::transmute(luid) };
    unsafe { attributes.SetBlob(&MFT_ENUM_ADAPTER_LUID, &luid_bytes)? };

    let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    unsafe {
        MFTEnum2(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            Some(&input),
            Some(&output),
            &attributes,
            &mut list,
            &mut count,
        )?;
    }
    let mut found = Vec::new();
    if !list.is_null() {
        let entries = unsafe { std::slice::from_raw_parts_mut(list, count as usize) };
        for entry in entries.iter_mut() {
            if let Some(activate) = entry.take() {
                found.push(activate);
            }
        }
        unsafe { CoTaskMemFree(Some(list as _)) };
    }
    Ok(found)
}

impl Encoder {
    pub fn new(
        device: &windows::Win32::Graphics::Direct3D11::ID3D11Device,
        luid: LUID,
        settings: &Settings,
    ) -> Result<Self> {
        let activate = hardware_encoders(luid)?.into_iter().next().ok_or_else(|| {
            windows::core::Error::new(E_FAIL, "no hardware H.264 encoder on this card")
        })?;
        let name = friendly_name(&activate);
        let transform: IMFTransform = unsafe { activate.ActivateObject()? };

        let attributes = unsafe { transform.GetAttributes()? };
        unsafe {
            attributes.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
            let _ = attributes.SetUINT32(&MF_LOW_LATENCY, 1);
        }

        let mut token = 0u32;
        let mut manager = None;
        unsafe { MFCreateDXGIDeviceManager(&mut token, &mut manager)? };
        let manager = manager.expect("device manager");
        unsafe {
            manager.ResetDevice(device, token)?;
            transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)?;
        }

        let codec: ICodecAPI = transform.cast()?;
        // Rate control and latency before the types: some encoders read them only then.
        unsafe {
            let _ = codec.SetValue(
                &CODECAPI_AVEncCommonRateControlMode,
                &VARIANT::from(eAVEncCommonRateControlMode_CBR.0 as u32),
            );
            let _ = codec.SetValue(
                &CODECAPI_AVEncCommonMeanBitRate,
                &VARIANT::from(settings.bitrate),
            );
            let _ = codec.SetValue(&CODECAPI_AVLowLatencyMode, &VARIANT::from(true));
            let _ = codec.SetValue(&CODECAPI_AVEncMPVGOPSize, &VARIANT::from(settings.gop));
            let _ = codec.SetValue(&CODECAPI_AVEncMPVDefaultBPictureCount, &VARIANT::from(0u32));
            // Speed over quality: the frame has to be out before the next one.
            let _ = codec.SetValue(&CODECAPI_AVEncCommonQualityVsSpeed, &VARIANT::from(33u32));
        }

        let output_type = unsafe { MFCreateMediaType()? };
        unsafe {
            output_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            output_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            output_type.SetUINT32(&MF_MT_AVG_BITRATE, settings.bitrate)?;
            output_type.SetUINT64(&MF_MT_FRAME_SIZE, ratio(settings.width, settings.height))?;
            output_type.SetUINT64(&MF_MT_FRAME_RATE, ratio(settings.frame_rate, 1))?;
            output_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, ratio(1, 1))?;
            output_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            // Main, not High: browsers without a graphics card's decoder offer no High, and
            // such a viewer could not watch at all. Main keeps CABAC; it loses only the 8x8
            // transform.
            output_type.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Main.0 as u32)?;
            // What the converter produces, said in the stream so players use the same colours.
            output_type.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
            output_type.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
            output_type.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
            output_type.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
            transform.SetOutputType(0, &output_type, 0)?;
        }

        let input_type = Self::nv12_input(&transform)?;
        unsafe {
            input_type.SetUINT64(&MF_MT_FRAME_SIZE, ratio(settings.width, settings.height))?;
            input_type.SetUINT64(&MF_MT_FRAME_RATE, ratio(settings.frame_rate, 1))?;
            transform.SetInputType(0, &input_type, 0)?;
        }

        let info = unsafe { transform.GetOutputStreamInfo(0)? };
        let provides_samples = info.dwFlags
            & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32
                | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32)
            != 0;

        let events: IMFMediaEventGenerator = transform.cast()?;
        unsafe {
            transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
        }
        Ok(Self {
            transform,
            events,
            codec,
            _manager: manager,
            provides_samples,
            output_size: info.cbSize.max(1 << 20),
            name,
        })
    }

    /// The encoder's own NV12 input type, which carries what it needs beyond the format.
    fn nv12_input(transform: &IMFTransform) -> Result<IMFMediaType> {
        for index in 0.. {
            let candidate = match unsafe { transform.GetInputAvailableType(0, index) } {
                Ok(candidate) => candidate,
                Err(_) => break,
            };
            if unsafe { candidate.GetGUID(&MF_MT_SUBTYPE)? } == MFVideoFormat_NV12 {
                return Ok(candidate);
            }
        }
        let fallback = unsafe { MFCreateMediaType()? };
        unsafe {
            fallback.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            fallback.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
        }
        Ok(fallback)
    }

    /// What the encoder has to say, if anything, without waiting.
    pub fn poll_event(&self) -> Result<Option<Event>> {
        let event = match unsafe { self.events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
            Ok(event) => event,
            Err(error) if error.code() == MF_E_NO_EVENTS_AVAILABLE => return Ok(None),
            Err(error) => return Err(error),
        };
        let kind = unsafe { event.GetType()? };
        Ok(Some(if kind == METransformNeedInput.0 as u32 {
            Event::NeedInput
        } else if kind == METransformHaveOutput.0 as u32 {
            Event::HaveOutput
        } else {
            Event::Other
        }))
    }

    pub fn push(&self, texture: &ID3D11Texture2D, time: i64, duration: i64) -> Result<()> {
        let buffer =
            unsafe { MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, texture, 0, false)? };
        if let Ok(planar) = buffer.cast::<IMF2DBuffer>() {
            let length = unsafe { planar.GetContiguousLength()? };
            unsafe { buffer.SetCurrentLength(length)? };
        }
        let sample = unsafe { MFCreateSample()? };
        unsafe {
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(time)?;
            sample.SetSampleDuration(duration)?;
            self.transform.ProcessInput(0, &sample, 0)?;
        }
        Ok(())
    }

    pub fn pull(&self) -> Result<Option<Encoded>> {
        let own_sample = if self.provides_samples {
            None
        } else {
            let sample = unsafe { MFCreateSample()? };
            let buffer = unsafe { MFCreateMemoryBuffer(self.output_size)? };
            unsafe { sample.AddBuffer(&buffer)? };
            Some(sample)
        };
        let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: ManuallyDrop::new(own_sample),
            dwStatus: 0,
            pEvents: ManuallyDrop::new(None),
        }];
        let mut status = 0u32;
        let result = unsafe { self.transform.ProcessOutput(0, &mut buffers, &mut status) };
        let sample = unsafe { ManuallyDrop::take(&mut buffers[0].pSample) };
        unsafe { ManuallyDrop::drop(&mut buffers[0].pEvents) };
        if let Err(error) = result {
            if error.code() == MF_E_TRANSFORM_NEED_MORE_INPUT {
                return Ok(None);
            }
            return Err(error);
        }
        let Some(sample) = sample else {
            return Ok(None);
        };
        let time = unsafe { sample.GetSampleTime().unwrap_or(0) };
        let key_frame =
            unsafe { sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) } != 0;
        let buffer = unsafe { sample.ConvertToContiguousBuffer()? };
        let mut pointer = std::ptr::null_mut();
        let mut length = 0u32;
        unsafe { buffer.Lock(&mut pointer, None, Some(&mut length))? };
        let data = unsafe { std::slice::from_raw_parts(pointer, length as usize) }.to_vec();
        unsafe { buffer.Unlock()? };
        Ok(Some(Encoded {
            data,
            time,
            key_frame,
        }))
    }

    /// The next frame comes out as a key frame.
    pub fn request_key_frame(&self) {
        unsafe {
            let _ = self
                .codec
                .SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1u32));
        }
    }

    /// Changes the bitrate on the fly, for encoders that allow it.
    pub fn set_bitrate(&self, bitrate: u32) {
        unsafe {
            let _ = self
                .codec
                .SetValue(&CODECAPI_AVEncCommonMeanBitRate, &VARIANT::from(bitrate));
        }
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, 0);
        }
    }
}

pub fn startup() -> Result<()> {
    unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }
}
