//! dispeaker-host: what the desktop app asks of Windows that Node cannot reach — the window in
//! front, the system's timer throttling, the graphics card's counters and the games running.
//! One process for the whole session, speaking JSON lines on stdin and stdout:
//!
//! - request:  `{"id": 1, "method": "foreground", "params": {}}`
//! - answer:   `{"id": 1, "result": ...}` or `{"id": 1, "error": "..."}`
//! - event:    `{"event": "gpu", "data": ...}`, while a watch is on.
//!
//! It ends when stdin closes, that is, with the app.

mod audio;
mod display;
mod games;
mod gpu;
mod processes;
mod repeat;
mod timers;
mod windows_info;

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Request {
    id: u64,
    method: String,
    #[serde(default)]
    params: Value,
}

/// Writes whole lines, one at a time, from any thread.
pub struct Output(Mutex<std::io::Stdout>);

impl Output {
    pub fn send(&self, value: &Value) {
        if let Ok(mut out) = self.0.lock() {
            let _ = writeln!(out, "{value}");
            let _ = out.flush();
        }
    }

    pub fn event(&self, name: &str, data: Value) {
        self.send(&json!({ "event": name, "data": data }));
    }
}

struct Host {
    gpu: gpu::Watcher,
    games: games::Watcher,
}

fn param<T: serde::de::DeserializeOwned>(params: &Value, name: &str) -> Result<T, String> {
    serde_json::from_value(params.get(name).cloned().unwrap_or(Value::Null))
        .map_err(|error| format!("bad parameter {name}: {error}"))
}

fn handle(host: &Host, request: &Request) -> Result<Value, String> {
    let params = &request.params;
    match request.method.as_str() {
        "foreground" => Ok(json!(windows_info::foreground())),
        "keepTimersFine" => {
            let pids: Vec<u32> = param(params, "pids")?;
            Ok(json!({ "done": timers::keep_fine(&pids) }))
        }
        "watchGpu" => {
            let on: bool = param(params, "on")?;
            let root: u32 = if on { param(params, "root")? } else { 0 };
            host.gpu.set(on.then_some(root));
            Ok(json!({}))
        }
        "watchGames" => {
            let on: bool = param(params, "on")?;
            let added: Vec<String> = param(params, "added").unwrap_or_default();
            host.games.set(on.then_some(added));
            Ok(json!({}))
        }
        "games" => {
            let added: Vec<String> = param(params, "added").unwrap_or_default();
            Ok(json!(games::detect_once(&added)))
        }
        "windows" => Ok(json!(games::running_windows())),
        "monitors" => Ok(json!(display::monitors())),
        "announceTaskbar" => {
            let handle: i64 = param(params, "handle")?;
            Ok(json!({ "done": windows_info::announce_taskbar(handle) }))
        }
        "describe" => {
            let handle: i64 = param(params, "handle")?;
            Ok(json!(display::describe(handle)))
        }
        // For the diagnostics: what the launchers say is installed.
        "installed" => Ok(json!(games::installed())),
        other => Err(format!("unknown method {other}")),
    }
}

fn main() {
    display::use_real_pixels();
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    // A capture of the sound of a share runs as a process of its own: its output is the sound.
    if arguments.first().is_some_and(|first| first == "audio") {
        std::process::exit(audio::run(&arguments[1..]));
    }
    let output = Arc::new(Output(Mutex::new(std::io::stdout())));
    let host = Host {
        gpu: gpu::Watcher::new(output.clone()),
        games: games::Watcher::new(output.clone()),
    };
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                output.send(&json!({ "error": format!("bad request: {error}") }));
                continue;
            }
        };
        let answer = match handle(&host, &request) {
            Ok(result) => json!({ "id": request.id, "result": result }),
            Err(error) => json!({ "id": request.id, "error": error }),
        };
        output.send(&answer);
    }
}
