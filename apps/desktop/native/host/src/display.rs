//! Monitors and the windows that cover one, in real pixels (the process is per-monitor DPI
//! aware): what the screen capture needs to know which monitor to take.

use std::collections::HashSet;

use serde::Serialize;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromRect,
};
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GWL_EXSTYLE, GetClassNameW, GetWindowLongPtrW, GetWindowPlacement, GetWindowRect,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, WINDOWPLACEMENT, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

/// Real pixels, whatever the scaling of each monitor. Called once, before anything else.
pub fn use_real_pixels() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

#[derive(Serialize)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl From<RECT> for Area {
    fn from(rect: RECT) -> Self {
        Self {
            x: rect.left,
            y: rect.top,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
        }
    }
}

#[derive(Serialize)]
pub struct Monitor {
    pub adapter: u32,
    pub output: u32,
    #[serde(flatten)]
    pub area: Area,
}

/// The monitors as the screen capture (Desktop Duplication) numbers them: by graphics card,
/// then by output of that card, with where each one sits on the desktop.
pub fn monitors() -> Vec<Monitor> {
    let mut list = Vec::new();
    let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else {
        return list;
    };
    for adapter_index in 0.. {
        let Ok(adapter) = (unsafe { factory.EnumAdapters1(adapter_index) }) else {
            break;
        };
        for output_index in 0.. {
            let Ok(output) = (unsafe { adapter.EnumOutputs(output_index) }) else {
                break;
            };
            let Ok(description) = (unsafe { output.GetDesc() }) else {
                continue;
            };
            if !description.AttachedToDesktop.as_bool() {
                continue;
            }
            list.push(Monitor {
                adapter: adapter_index,
                output: output_index,
                area: description.DesktopCoordinates.into(),
            });
        }
    }
    list
}

#[derive(Serialize)]
pub struct Described {
    pub covers: bool,
    pub monitor: Area,
}

fn monitor_of(rect: &RECT) -> Option<RECT> {
    let monitor = unsafe { MonitorFromRect(rect, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    unsafe { GetMonitorInfoW(monitor, &mut info) }
        .as_bool()
        .then_some(info.rcMonitor)
}

fn covers(rect: &RECT, monitor: &RECT) -> bool {
    rect.left <= monitor.left
        && rect.top <= monitor.top
        && rect.right >= monitor.right
        && rect.bottom >= monitor.bottom
}

/// Whether a window covers a whole monitor, and which.
pub fn describe(handle: i64) -> Option<Described> {
    let window = HWND(handle as *mut std::ffi::c_void);
    let mut rect = RECT::default();
    unsafe { GetWindowRect(window, &mut rect) }.ok()?;
    let monitor = monitor_of(&rect)?;
    Some(Described {
        covers: !unsafe { IsIconic(window) }.as_bool() && covers(&rect, &monitor),
        monitor: monitor.into(),
    })
}

struct Search<'a> {
    excluded: &'a HashSet<u32>,
    found: u32,
    minimised: u32,
}

/// The front-most window that takes a whole monitor and belongs to a program: a game, a film.
/// Overlays (click-through or never activated), the desktop itself and hidden windows do not
/// count. A full-screen game minimises itself when the user leaves it to start the share, so
/// failing a window on screen, a minimised one that would cover a monitor is taken.
pub fn find_covering(excluded: &HashSet<u32>) -> u32 {
    let mut search = Search {
        excluded,
        found: 0,
        minimised: 0,
    };
    unsafe {
        let _ = EnumWindows(Some(visit), LPARAM(&mut search as *mut Search as isize));
    }
    if search.found != 0 {
        search.found
    } else {
        search.minimised
    }
}

unsafe extern "system" fn visit(window: HWND, lparam: LPARAM) -> BOOL {
    // The `Search` passed by `find_covering`, alive for the whole enumeration.
    let search = unsafe { &mut *(lparam.0 as *mut Search) };
    if !unsafe { IsWindowVisible(window) }.as_bool() {
        return TRUE;
    }
    let mut cloaked = 0u32;
    let _ = unsafe {
        DwmGetWindowAttribute(
            window,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut std::ffi::c_void,
            4,
        )
    };
    if cloaked != 0 {
        return TRUE;
    }
    let style = unsafe { GetWindowLongPtrW(window, GWL_EXSTYLE) } as u32;
    if style & (WS_EX_TRANSPARENT.0 | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) != 0 {
        return TRUE;
    }
    let mut class = [0u16; 64];
    let length = unsafe { GetClassNameW(window, &mut class) }.max(0) as usize;
    let class = String::from_utf16_lossy(&class[..length]);
    if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd") {
        return TRUE;
    }
    let iconic = unsafe { IsIconic(window) }.as_bool();
    let rect = if iconic {
        let mut placement = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        if unsafe { GetWindowPlacement(window, &mut placement) }.is_err() {
            return TRUE;
        }
        placement.rcNormalPosition
    } else {
        let mut rect = RECT::default();
        if unsafe { GetWindowRect(window, &mut rect) }.is_err() {
            return TRUE;
        }
        rect
    };
    let Some(monitor) = monitor_of(&rect) else {
        return TRUE;
    };
    if !covers(&rect, &monitor) {
        return TRUE;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(window, Some(&mut pid as *mut u32)) };
    if pid == 0 || search.excluded.contains(&pid) {
        return TRUE;
    }
    if iconic {
        if search.minimised == 0 {
            search.minimised = pid;
        }
        return TRUE;
    }
    search.found = pid;
    BOOL(0)
}
