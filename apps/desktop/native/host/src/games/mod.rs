//! Which games are running: those the launchers installed (Steam, Epic, Xbox, GOG), the ones
//! the user added by hand, and any other program taking a whole monitor that is not a browser
//! or a video player. Reported with the window to share, when there is one.

mod libraries;
mod registry;

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows::core::HSTRING;

use crate::Output;
use crate::processes::{self, Process};
use crate::repeat::Repeater;
use crate::windows_info::{self, TopWindow};
use libraries::Installed;

const INTERVAL: Duration = Duration::from_secs(3);
/// Games get installed and removed; the launchers' lists are read again this often.
const RESCAN: Duration = Duration::from_secs(60);

/// Programs that take the whole screen without being games.
const NOT_GAMES: &[&str] = &[
    "explorer.exe",
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "opera.exe",
    "opera_gx.exe",
    "brave.exe",
    "vivaldi.exe",
    "arc.exe",
    "vlc.exe",
    "mpv.exe",
    "potplayermini64.exe",
    "mpc-hc64.exe",
    "mpc-be64.exe",
    "wmplayer.exe",
    "video.ui.exe",
    "applicationframehost.exe",
    "textinputhost.exe",
    "shellexperiencehost.exe",
    "searchhost.exe",
    "lockapp.exe",
    "steamwebhelper.exe",
    "steam.exe",
    "epicgameslauncher.exe",
    "obs64.exe",
    "spotify.exe",
    "discord.exe",
    "dispeaker.exe",
    "electron.exe",
    "teams.exe",
    "ms-teams.exe",
    "zoom.exe",
    "powerpnt.exe",
    "winword.exe",
    "excel.exe",
    "acrord32.exe",
    "acrobat.exe",
    "code.exe",
];

#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    pub pid: u32,
    pub name: String,
    /// File name of the program, lowercase: how the user's choices refer to it.
    pub exe: String,
    pub path: String,
    /// `steam`, `epic`, `xbox`, `gog`, `added` (by the user) or `fullscreen` (a guess).
    pub source: &'static str,
    /// The window to share; `None` while the game has none yet (still starting).
    pub window_handle: Option<i64>,
    pub fullscreen: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningWindow {
    pub exe: String,
    pub title: String,
    pub path: String,
}

/// The product name a program declares in its version information.
fn description_of(path: &str) -> Option<String> {
    let file = HSTRING::from(path);
    unsafe {
        let size = GetFileVersionInfoSizeW(&file, None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(&file, 0, size, data.as_mut_ptr() as *mut std::ffi::c_void).ok()?;
        let base = data.as_ptr() as *const std::ffi::c_void;
        // The first language and code page the file has strings in.
        let mut pointer = std::ptr::null_mut();
        let mut length = 0u32;
        let language = if VerQueryValueW(
            base,
            &HSTRING::from(r"\VarFileInfo\Translation"),
            &mut pointer,
            &mut length,
        )
        .as_bool()
            && length >= 4
        {
            let pair = pointer as *const u16;
            format!("{:04x}{:04x}", *pair, *pair.add(1))
        } else {
            "040904b0".to_string()
        };
        for field in ["FileDescription", "ProductName"] {
            let query = HSTRING::from(format!(r"\StringFileInfo\{language}\{field}"));
            if VerQueryValueW(base, &query, &mut pointer, &mut length).as_bool() && length > 1 {
                let chars = std::slice::from_raw_parts(pointer as *const u16, length as usize - 1);
                let text = String::from_utf16_lossy(chars).trim().to_string();
                if !text.is_empty() {
                    return Some(text);
                }
            }
        }
        None
    }
}

fn stem(exe: &str) -> String {
    Path::new(exe)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// What detection keeps between passes: the launchers' lists and the paths already asked for.
pub struct Detector {
    libraries: Vec<Installed>,
    scanned: Option<Instant>,
    paths: HashMap<u32, Option<String>>,
}

impl Detector {
    pub fn new() -> Self {
        Self {
            libraries: Vec::new(),
            scanned: None,
            paths: HashMap::new(),
        }
    }

    fn path(&mut self, pid: u32) -> Option<String> {
        self.paths
            .entry(pid)
            .or_insert_with(|| processes::path_of(pid))
            .clone()
    }

    pub fn detect(&mut self, added: &[String]) -> Vec<Game> {
        if self.scanned.is_none_or(|at| at.elapsed() > RESCAN) {
            self.libraries = libraries::scan();
            self.scanned = Some(Instant::now());
        }
        let running = processes::all();
        let alive: HashSet<u32> = running.iter().map(|p| p.pid).collect();
        self.paths.retain(|pid, _| alive.contains(pid));
        let added: HashSet<String> = added.iter().map(|exe| exe.to_lowercase()).collect();
        let own = processes::tree(std::process::id(), &running);

        let mut windows: HashMap<u32, Vec<TopWindow>> = HashMap::new();
        for window in windows_info::top_windows() {
            windows.entry(window.process_id).or_default().push(window);
        }
        // The window to share for a process: the largest one on screen.
        let main_window = |pid: u32| {
            windows.get(&pid).and_then(|list| {
                list.iter()
                    .filter(|w| !w.minimized)
                    .max_by_key(|w| w.area)
                    .or(list.first())
            })
        };

        // One entry per game: the process of it that shows the main window wins.
        let mut found: HashMap<String, (Game, i64)> = HashMap::new();
        let mut consider = |key: String, game: Game, area: i64| {
            let better = found.get(&key).is_none_or(|(_, best)| area > *best);
            if better {
                found.insert(key, (game, area));
            }
        };
        for Process { pid, exe, .. } in &running {
            if own.contains(pid) {
                continue;
            }
            let lower = exe.to_lowercase();
            let window = main_window(*pid);
            let is_added = added.contains(&lower);
            let fullscreen = window.is_some_and(|w| w.covers_screen && !w.minimized);
            let Some(path) = self.path(*pid) else {
                continue;
            };
            let lower_path = path.to_lowercase();
            let library = self
                .libraries
                .iter()
                .find(|game| lower_path.starts_with(&game.folder))
                .cloned();
            let source = match (&library, is_added) {
                (Some(game), _) => game.source,
                (None, true) => "added",
                (None, false) if fullscreen && !NOT_GAMES.contains(&lower.as_str()) => "fullscreen",
                _ => continue,
            };
            let name = library
                .as_ref()
                .map(|game| game.name.clone())
                .unwrap_or_else(|| {
                    // A window title says what is open, not what the program is: only a game
                    // taking the whole screen is trusted to carry its own name there.
                    description_of(&path)
                        .or_else(|| {
                            (source == "fullscreen")
                                .then(|| window.map(|w| w.title.clone()))
                                .flatten()
                        })
                        .unwrap_or_else(|| stem(exe))
                });
            let key = library
                .map(|game| game.folder)
                .unwrap_or_else(|| lower.clone());
            consider(
                key,
                Game {
                    pid: *pid,
                    name,
                    exe: lower,
                    path,
                    source,
                    window_handle: window.map(|w| w.handle),
                    fullscreen,
                },
                window.map(|w| w.area).unwrap_or(-1),
            );
        }
        let mut games: Vec<Game> = found.into_values().map(|(game, _)| game).collect();
        games.sort_by_key(|a| a.name.to_lowercase());
        games
    }
}

/// The games the launchers know of, by name and where they come from.
pub fn installed() -> Vec<serde_json::Value> {
    libraries::scan()
        .into_iter()
        .map(|game| json!({ "name": game.name, "source": game.source, "folder": game.folder }))
        .collect()
}

/// One pass, for an answer now (the share picker opening).
pub fn detect_once(added: &[String]) -> Vec<Game> {
    Detector::new().detect(added)
}

/// Programs with a window, for the user to pick one and call it a game.
pub fn running_windows() -> Vec<RunningWindow> {
    let running = processes::all();
    let own = processes::tree(std::process::id(), &running);
    let exes: HashMap<u32, String> = running.into_iter().map(|p| (p.pid, p.exe)).collect();
    let mut seen = HashSet::new();
    let mut list = Vec::new();
    for window in windows_info::top_windows() {
        if own.contains(&window.process_id) {
            continue;
        }
        let Some(exe) = exes.get(&window.process_id).map(|e| e.to_lowercase()) else {
            continue;
        };
        if NOT_GAMES.contains(&exe.as_str()) || !seen.insert(exe.clone()) {
            continue;
        }
        let path = processes::path_of(window.process_id).unwrap_or_default();
        list.push(RunningWindow {
            exe,
            title: window.title,
            path,
        });
    }
    list.sort_by_key(|a| a.title.to_lowercase());
    list
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

    /// Reports the games running whenever the list changes, or stops with `None`.
    pub fn set(&self, added: Option<Vec<String>>) {
        let Some(added) = added else {
            self.repeater.stop();
            return;
        };
        let output = self.output.clone();
        let detector = Mutex::new(Detector::new());
        let mut last: Option<Vec<Game>> = None;
        self.repeater.start(INTERVAL, move || {
            let started = Instant::now();
            let Ok(mut detector) = detector.lock() else {
                return Duration::ZERO;
            };
            let games = detector.detect(&added);
            if last.as_ref() != Some(&games) {
                output.event("games", json!(games));
                last = Some(games);
            }
            started.elapsed()
        });
    }
}
