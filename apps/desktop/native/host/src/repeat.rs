//! Work done again and again on a thread of its own while a watch is on.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// One running repetition at most: starting another stops the one before.
#[derive(Default)]
pub struct Repeater {
    stop: Mutex<Option<Arc<AtomicBool>>>,
}

impl Repeater {
    /// Runs `work` now and then every `interval`, until `stop` or the next `start`. `work`
    /// returns how long it already spent waiting (a counter sample takes a while).
    pub fn start<F>(&self, interval: Duration, mut work: F)
    where
        F: FnMut() -> Duration + Send + 'static,
    {
        self.stop();
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut stop) = self.stop.lock() {
            *stop = Some(flag.clone());
        }
        thread::spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                let spent = work();
                if let Some(rest) = interval.checked_sub(spent) {
                    thread::sleep(rest);
                }
            }
        });
    }

    pub fn stop(&self) {
        if let Ok(mut stop) = self.stop.lock()
            && let Some(flag) = stop.take()
        {
            flag.store(true, Ordering::Relaxed);
        }
    }
}
