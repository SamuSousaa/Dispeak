//! How busy the graphics card is, engine by engine, from the Windows performance counters
//! (`\GPU Engine(*)\Utilization Percentage`, the ones the Task Manager reads): for the app and
//! the programs it started, and for the whole machine. Each engine is sent as
//! `<engine id>|<type>` with its use summed over processes; the app folds them by kind.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use windows::Win32::System::Performance::{
    PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_MORE_DATA, PdhAddEnglishCounterW,
    PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW,
};
use windows::core::{PCWSTR, w};

use crate::Output;
use crate::processes;
use crate::repeat::Repeater;

const INTERVAL: Duration = Duration::from_secs(2);

/// One counter query, open while watching.
struct Query {
    query: isize,
    counter: isize,
}

// The handles are only ever used from the watching thread.
unsafe impl Send for Query {}

impl Query {
    fn open() -> Option<Self> {
        let mut query = 0isize;
        let mut counter = 0isize;
        unsafe {
            if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
                return None;
            }
            if PdhAddEnglishCounterW(
                query,
                w!("\\GPU Engine(*)\\Utilization Percentage"),
                0,
                &mut counter,
            ) != 0
            {
                let _ = PdhCloseQuery(query);
                return None;
            }
            // Rates need two samples: this is the first.
            let _ = PdhCollectQueryData(query);
        }
        Some(Self { query, counter })
    }

    /// Utilisation of every instance since the last call, by instance name.
    fn sample(&self) -> Vec<(String, f64)> {
        unsafe {
            if PdhCollectQueryData(self.query) != 0 {
                return Vec::new();
            }
            let mut bytes = 0u32;
            let mut count = 0u32;
            let status = PdhGetFormattedCounterArrayW(
                self.counter,
                PDH_FMT_DOUBLE,
                &mut bytes,
                &mut count,
                None,
            );
            if status != PDH_MORE_DATA || bytes == 0 {
                return Vec::new();
            }
            // u64 words: the items hold doubles and pointers.
            let mut buffer = vec![0u64; (bytes as usize).div_ceil(8)];
            let items = buffer.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
            if PdhGetFormattedCounterArrayW(
                self.counter,
                PDH_FMT_DOUBLE,
                &mut bytes,
                &mut count,
                Some(items),
            ) != 0
            {
                return Vec::new();
            }
            std::slice::from_raw_parts(items, count as usize)
                .iter()
                .filter_map(|item| {
                    let name = item.szName.to_string().ok()?;
                    Some((name, item.FmtValue.Anonymous.doubleValue))
                })
                .collect()
        }
    }
}

impl Drop for Query {
    fn drop(&mut self) {
        unsafe {
            let _ = PdhCloseQuery(self.query);
        }
    }
}

/// `pid_1234_luid_0x0_0x1_phys_0_eng_3_engtype_VideoDecode` → (1234, "luid_…_eng_3|VideoDecode").
fn parse_instance(name: &str) -> Option<(u32, String)> {
    let rest = name.strip_prefix("pid_")?;
    let (pid, rest) = rest.split_once('_')?;
    let (engine, kind) = rest.split_once("_engtype_")?;
    Some((pid.parse().ok()?, format!("{engine}|{kind}")))
}

pub struct Watcher {
    output: Arc<Output>,
    repeater: Repeater,
}

impl Watcher {
    pub fn new(output: Arc<Output>) -> Self {
        Self {
            output,
            repeater: Repeater::default(),
        }
    }

    /// Starts sampling for the process tree of `root`, or stops with `None`.
    pub fn set(&self, root: Option<u32>) {
        let Some(root) = root else {
            self.repeater.stop();
            return;
        };
        let output = self.output.clone();
        let mut query = None;
        self.repeater.start(INTERVAL, move || {
            let started = Instant::now();
            let query = match &mut query {
                Some(query) => query,
                slot => {
                    *slot = Query::open();
                    match slot {
                        Some(query) => query,
                        None => return Duration::ZERO,
                    }
                }
            };
            let mine = processes::tree(root, &processes::all());
            let mut app: HashMap<String, f64> = HashMap::new();
            let mut all: HashMap<String, f64> = HashMap::new();
            for (name, value) in query.sample() {
                let Some((pid, engine)) = parse_instance(&name) else {
                    continue;
                };
                if mine.contains(&pid) {
                    *app.entry(engine.clone()).or_default() += value;
                }
                *all.entry(engine).or_default() += value;
            }
            output.event("gpu", json!({ "app": app, "all": all }));
            started.elapsed()
        });
    }
}

#[cfg(test)]
mod tests {
    use super::parse_instance;

    #[test]
    fn reads_the_process_and_the_engine() {
        assert_eq!(
            parse_instance(
                "pid_10004_luid_0x00000000_0x0000cd99_phys_0_eng_7_engtype_video codec engine"
            ),
            Some((
                10004,
                "luid_0x00000000_0x0000cd99_phys_0_eng_7|video codec engine".into()
            ))
        );
        assert_eq!(parse_instance("_Total"), None);
    }
}
