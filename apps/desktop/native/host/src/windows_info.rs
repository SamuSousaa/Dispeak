//! Top-level windows: the one in front, and every one a person could be looking at.

use serde::Serialize;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE, WPARAM};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GWL_EXSTYLE, GetForegroundWindow, GetWindowLongW, GetWindowRect,
    GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    PostMessageW, RegisterWindowMessageW, WS_EX_TOOLWINDOW,
};
use windows::core::w;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Foreground {
    pub handle: i64,
    pub process_id: u32,
    /// The window takes its whole monitor: a game, a film, a presentation.
    pub covers_screen: bool,
}

pub struct TopWindow {
    pub handle: i64,
    pub process_id: u32,
    pub title: String,
    pub covers_screen: bool,
    pub minimized: bool,
    /// Area on screen, to tell the main window of a program from its small ones.
    pub area: i64,
}

/// Sends a window the message Windows broadcasts when the taskbar is created anew. Electron
/// answers it by adding the window's taskbar thumbnail buttons again: the only way to get them
/// back once the window's taskbar button was made again (the window hidden and shown) or did not
/// exist yet when they were first set.
pub fn announce_taskbar(handle: i64) -> bool {
    unsafe {
        let message = RegisterWindowMessageW(w!("TaskbarCreated"));
        message != 0
            && PostMessageW(
                HWND(handle as *mut std::ffi::c_void),
                message,
                WPARAM(0),
                LPARAM(0),
            )
            .is_ok()
    }
}

/// The process that owns a window, by its handle as a number.
pub fn process_of_handle(handle: i64) -> u32 {
    process_of(HWND(handle as *mut std::ffi::c_void))
}

fn process_of(window: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(window, Some(&mut pid as *mut u32)) };
    pid
}

/// The window's rectangle and whether it covers the monitor it is on.
fn placement(window: HWND) -> (RECT, bool) {
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(window, &mut rect) }.is_err() {
        return (rect, false);
    }
    let monitor = unsafe { MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        return (rect, false);
    }
    let m = info.rcMonitor;
    let covers = rect.left <= m.left
        && rect.top <= m.top
        && rect.right >= m.right
        && rect.bottom >= m.bottom;
    (rect, covers)
}

pub fn foreground() -> Option<Foreground> {
    let window = unsafe { GetForegroundWindow() };
    if window.0.is_null() {
        return None;
    }
    Some(Foreground {
        handle: window.0 as i64,
        process_id: process_of(window),
        covers_screen: placement(window).1,
    })
}

/// Visible windows with a title, leaving out tool windows and the ghosts Windows keeps cloaked
/// (suspended Store apps, other virtual desktops).
pub fn top_windows() -> Vec<TopWindow> {
    let mut list: Vec<TopWindow> = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(collect),
            LPARAM(&mut list as *mut Vec<TopWindow> as isize),
        );
    }
    list
}

unsafe extern "system" fn collect(window: HWND, lparam: LPARAM) -> BOOL {
    // The pointer passed by `top_windows`, alive for the whole enumeration.
    let list = unsafe { &mut *(lparam.0 as *mut Vec<TopWindow>) };
    if !unsafe { IsWindowVisible(window) }.as_bool() {
        return TRUE;
    }
    let style = unsafe { GetWindowLongW(window, GWL_EXSTYLE) } as u32;
    if style & WS_EX_TOOLWINDOW.0 != 0 {
        return TRUE;
    }
    let mut cloaked = 0u32;
    let _ = unsafe {
        DwmGetWindowAttribute(
            window,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        )
    };
    if cloaked != 0 {
        return TRUE;
    }
    let length = unsafe { GetWindowTextLengthW(window) };
    if length <= 0 {
        return TRUE;
    }
    let mut buffer = vec![0u16; length as usize + 1];
    let copied = unsafe { GetWindowTextW(window, &mut buffer) }.max(0) as usize;
    let (rect, covers_screen) = placement(window);
    list.push(TopWindow {
        handle: window.0 as i64,
        process_id: process_of(window),
        title: String::from_utf16_lossy(&buffer[..copied]),
        covers_screen,
        minimized: unsafe { IsIconic(window) }.as_bool(),
        area: i64::from(rect.right - rect.left) * i64::from(rect.bottom - rect.top),
    });
    TRUE
}
