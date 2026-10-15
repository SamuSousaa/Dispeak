//! Where the game launchers install games, and what each game is called. A process running a
//! program inside one of these folders is that game: the launchers know better than any guess.

use std::fs;
use std::path::{Path, PathBuf};

use windows::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

use super::registry;

#[derive(Clone, Debug)]
pub struct Installed {
    pub name: String,
    /// The game's folder, lowercase, ending in a backslash.
    pub folder: String,
    /// `steam`, `epic`, `xbox` or `gog`.
    pub source: &'static str,
}

fn folder_key(path: &Path) -> String {
    let mut text = path.to_string_lossy().replace('/', "\\").to_lowercase();
    if !text.ends_with('\\') {
        text.push('\\');
    }
    text
}

/// The quoted strings of a line of Valve's KeyValues text (`"key"  "value"`), unescaped.
fn quoted(line: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c != '"' {
            continue;
        }
        let mut text = String::new();
        while let Some(c) = chars.next() {
            match c {
                '"' => break,
                '\\' => {
                    if let Some(next) = chars.next() {
                        text.push(next);
                    }
                }
                other => text.push(other),
            }
        }
        found.push(text);
    }
    found
}

/// Every `"key" "value"` pair of a KeyValues file with that key, in order.
fn values<'a>(text: &'a str, key: &'a str) -> impl Iterator<Item = String> + 'a {
    text.lines().filter_map(move |line| {
        let parts = quoted(line);
        (parts.len() == 2 && parts[0].eq_ignore_ascii_case(key)).then(|| parts[1].clone())
    })
}

/// Tools Steam installs as if they were games, and apps sold there that run all the time.
fn steam_tool(name: &str) -> bool {
    let lower = name.to_lowercase();
    [
        "redistributable",
        "steamworks",
        "proton",
        "steam linux runtime",
        "steamvr",
        "dedicated server",
        "wallpaper engine",
        "soundpad",
        "lossless scaling",
    ]
    .iter()
    .any(|word| lower.contains(word))
}

fn steam() -> Vec<Installed> {
    let Some(root) = registry::string(HKEY_CURRENT_USER, r"Software\Valve\Steam", "SteamPath")
    else {
        return Vec::new();
    };
    let root = PathBuf::from(root);
    let mut libraries = vec![root.clone()];
    if let Ok(text) = fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")) {
        libraries.extend(values(&text, "path").map(PathBuf::from));
    }
    libraries.sort();
    libraries.dedup();
    let mut games = Vec::new();
    for library in libraries {
        let apps = library.join("steamapps");
        let Ok(entries) = fs::read_dir(&apps) else {
            continue;
        };
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().to_string();
            if !file.starts_with("appmanifest_") || !file.ends_with(".acf") {
                continue;
            }
            let Ok(text) = fs::read_to_string(entry.path()) else {
                continue;
            };
            let (Some(name), Some(dir)) = (
                values(&text, "name").next(),
                values(&text, "installdir").next(),
            ) else {
                continue;
            };
            if steam_tool(&name) {
                continue;
            }
            games.push(Installed {
                name,
                folder: folder_key(&apps.join("common").join(dir)),
                source: "steam",
            });
        }
    }
    games
}

fn epic() -> Vec<Installed> {
    let manifests = Path::new(r"C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests");
    let Ok(entries) = fs::read_dir(manifests) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "item"))
        .filter_map(|entry| {
            let text = fs::read_to_string(entry.path()).ok()?;
            let item: serde_json::Value = serde_json::from_str(&text).ok()?;
            // Epic lists its own apps and plugins too; only games count.
            let categories = item.get("AppCategories").and_then(|c| c.as_array());
            if let Some(categories) = categories
                && !categories.iter().any(|c| c.as_str() == Some("games"))
            {
                return None;
            }
            Some(Installed {
                name: item.get("DisplayName")?.as_str()?.to_string(),
                folder: folder_key(Path::new(item.get("InstallLocation")?.as_str()?)),
                source: "epic",
            })
        })
        .collect()
}

/// Game Pass and the Xbox app install each game in `<drive>:\XboxGames\<name>`.
fn xbox() -> Vec<Installed> {
    let mut games = Vec::new();
    for drive in b'C'..=b'Z' {
        let root = PathBuf::from(format!("{}:\\XboxGames", drive as char));
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            // The Xbox app keeps its own data there too.
            let name = entry.file_name().to_string_lossy().to_string();
            if !entry.path().is_dir() || name.eq_ignore_ascii_case("GameSave") {
                continue;
            }
            games.push(Installed {
                name,
                folder: folder_key(&entry.path()),
                source: "xbox",
            });
        }
    }
    games
}

fn gog() -> Vec<Installed> {
    const KEY: &str = r"SOFTWARE\WOW6432Node\GOG.com\Games";
    registry::subkeys(HKEY_LOCAL_MACHINE, KEY)
        .into_iter()
        .filter_map(|id| {
            let path = format!(r"{KEY}\{id}");
            Some(Installed {
                name: registry::string(HKEY_LOCAL_MACHINE, &path, "gameName")?,
                folder: folder_key(Path::new(&registry::string(
                    HKEY_LOCAL_MACHINE,
                    &path,
                    "path",
                )?)),
                source: "gog",
            })
        })
        .collect()
}

/// Every game the launchers on this machine know of.
pub fn scan() -> Vec<Installed> {
    let mut all = steam();
    all.extend(epic());
    all.extend(xbox());
    all.extend(gog());
    // The same library listed twice (Steam lists its own folder) counts once.
    all.sort_by(|a, b| a.folder.cmp(&b.folder));
    all.dedup_by(|a, b| a.folder == b.folder);
    // A folder inside another (a game's own launcher folder) matches the deeper one first.
    all.sort_by_key(|game| std::cmp::Reverse(game.folder.len()));
    all
}

#[cfg(test)]
mod tests {
    use super::{quoted, values};

    #[test]
    fn reads_keyvalues_lines() {
        assert_eq!(
            quoted(r#"		"path"		"D:\\SteamLibrary""#),
            vec!["path", r"D:\SteamLibrary"]
        );
        let manifest = "\"AppState\"\n{\n\t\"appid\"\t\t\"1091500\"\n\t\"name\"\t\t\"Cyberpunk 2077\"\n\t\"installdir\"\t\t\"Cyberpunk 2077\"\n}";
        assert_eq!(
            values(manifest, "name").collect::<Vec<_>>(),
            vec!["Cyberpunk 2077"]
        );
    }
}
