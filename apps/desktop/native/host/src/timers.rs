//! Windows 11 ignores the fine timers of a process whose windows are all covered and wakes it on
//! the 15.6 ms tick instead: behind a full-screen game a screen capture pacing itself on them
//! drops to 32 or 21 frames a second. Taking the throttling decision away from the system keeps
//! them fine. See apps/desktop/src/performance.ts.

use std::ffi::c_void;

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_POWER_THROTTLING_CURRENT_VERSION,
    PROCESS_POWER_THROTTLING_EXECUTION_SPEED, PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION,
    PROCESS_POWER_THROTTLING_STATE, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION,
    ProcessPowerThrottling, SetProcessInformation,
};

/// The processes it was done for.
pub fn keep_fine(pids: &[u32]) -> Vec<u32> {
    let state = PROCESS_POWER_THROTTLING_STATE {
        Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED
            | PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION,
        StateMask: 0,
    };
    pids.iter()
        .copied()
        .filter(|&pid| unsafe {
            let Ok(process) = OpenProcess(
                PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                pid,
            ) else {
                return false;
            };
            let done = SetProcessInformation(
                process,
                ProcessPowerThrottling,
                &state as *const _ as *const c_void,
                std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
            )
            .is_ok();
            let _ = CloseHandle(process);
            done
        })
        .collect()
}
