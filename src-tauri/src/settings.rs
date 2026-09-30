//! Settings, the personal dictionary and ignored issues, under
//! `$XDG_CONFIG_HOME/mk` (or `~/.config/mk`).
//!
//! Settings tolerate anything. Absent keys fall back to defaults, unknown keys
//! survive a save, and a malformed file still opens the editor — you need a
//! working editor to go fix it. One field of the wrong type costs only that
//! field: the loose parse below applies the file one key at a time and keeps
//! each key only if the result still parses.
//!
//! Every write is write-then-rename, so a crash mid-save leaves the old file
//! rather than half of the new one.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// `system`, `dark` or `light`.
    pub theme: String,
    /// `split`, `edit` or `preview`.
    pub view: String,
    pub font_size: u32,
    /// Empty means the stylesheet's own choice.
    pub editor_font: String,
    pub line_numbers: bool,
    pub wrap: bool,
    pub sync_scroll: bool,
    /// The rail of section dashes at the page's edge.
    pub section_nav: bool,
    /// Editor share of the split, 0–1.
    pub split: f64,
    pub problems_open: bool,
    pub grammar: bool,
    pub dialect: String,
    /// Write a document with a path a moment after each edit.
    pub auto_save: bool,
    /// Harper rule overrides by rule name; absent means Harper's default.
    pub rules: BTreeMap<String, bool>,
    /// Keys a newer build wrote. Kept so a save cannot drop them.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            view: "split".into(),
            font_size: 15,
            editor_font: String::new(),
            line_numbers: false,
            wrap: true,
            sync_scroll: true,
            section_nav: true,
            split: 0.5,
            problems_open: false,
            grammar: true,
            dialect: "American".into(),
            auto_save: false,
            rules: BTreeMap::new(),
            extra: Map::new(),
        }
    }
}

pub fn dir() -> PathBuf {
    // Windows has no HOME as a rule; its per-user settings go in %APPDATA%.
    #[cfg(windows)]
    if let Some(x) = std::env::var_os("APPDATA").filter(|v| !v.is_empty()) {
        return PathBuf::from(x).join("mk");
    }
    if let Some(x) = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(x).join("mk");
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    home.join(".config").join("mk")
}

pub fn parse(text: &str) -> Settings {
    if let Ok(s) = serde_json::from_str::<Settings>(text) {
        return s;
    }
    let Ok(Value::Object(user)) = serde_json::from_str::<Value>(text) else {
        return Settings::default();
    };
    let mut good = serde_json::to_value(Settings::default()).unwrap_or(Value::Null);
    for (k, v) in user {
        let mut trial = good.clone();
        trial[&k] = v;
        if serde_json::from_value::<Settings>(trial.clone()).is_ok() {
            good = trial;
        }
    }
    serde_json::from_value(good).unwrap_or_default()
}

pub fn load_from(dir: &Path) -> Settings {
    std::fs::read_to_string(dir.join("settings.json")).map(|t| parse(&t)).unwrap_or_default()
}

pub fn save_to(dir: &Path, s: &Settings) -> Result<(), String> {
    let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    write_atomic(&dir.join("settings.json"), text.as_bytes())
}

/// The personal dictionary: one word per line, so it can be edited by hand
/// and diffed. Blank lines and `#` comments are allowed.
pub fn words_from(dir: &Path) -> Vec<String> {
    let text = std::fs::read_to_string(dir.join("dictionary.txt")).unwrap_or_default();
    let set: BTreeSet<String> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect();
    set.into_iter().collect()
}

pub fn save_words_to(dir: &Path, words: &[String]) -> Result<(), String> {
    let mut text = String::from("# mk personal dictionary: one word per line.\n");
    for w in words {
        text.push_str(w);
        text.push('\n');
    }
    write_atomic(&dir.join("dictionary.txt"), text.as_bytes())
}

/// Ignored issues, by document path and Harper's context hash. Per document
/// because "this is fine here" is a judgement about one text, not a rule.
pub fn ignored_from(dir: &Path) -> BTreeMap<String, BTreeSet<String>> {
    std::fs::read_to_string(dir.join("ignored.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save_ignored_to(dir: &Path, map: &BTreeMap<String, BTreeSet<String>>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    write_atomic(&dir.join("ignored.json"), text.as_bytes())
}

/// How many recently opened files to remember. Enough to span a work session
/// without turning the menu into a list nobody reads to the bottom of.
pub const RECENT_MAX: usize = 12;

/// The files opened lately, most recent first. A short list of paths, so it is
/// easy to read and edit by hand, like the rest of the config directory.
pub fn recent_from(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join("recent.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
        .unwrap_or_default()
}

pub fn save_recent_to(dir: &Path, recent: &[String]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(recent).map_err(|e| e.to_string())?;
    write_atomic(&dir.join("recent.json"), text.as_bytes())
}

/// Move `path` to the front, dropping any earlier mention of it, and keep the
/// list to `RECENT_MAX`. Reopening a file is what promotes it, so the menu
/// stays in the order files were last touched.
pub fn push_recent(recent: &mut Vec<String>, path: String) {
    recent.retain(|p| p != &path);
    recent.insert(0, path);
    recent.truncate(RECENT_MAX);
}

/// Write to a sibling temporary file and rename it over the target.
///
/// The target is resolved through symlinks first: renaming over a symlink
/// replaces the link with a regular file, which quietly forks a dotfile
/// managed from somewhere else. Permissions of an existing file are carried
/// over, because a rename installs the temporary file's mode, not the old one.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let parent = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    let name = target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    let tmp = parent.join(format!(".{name}.mk-{}.tmp", std::process::id()));
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        if let Ok(meta) = std::fs::metadata(&target) {
            std::fs::set_permissions(&tmp, meta.permissions())?;
        }
        std::fs::rename(&tmp, &target)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("{}: {e}", target.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mk-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn garbage_is_defaults() {
        assert_eq!(parse("{ not json"), Settings::default());
        assert_eq!(parse("[1, 2]"), Settings::default());
        assert_eq!(parse(""), Settings::default());
    }

    #[test]
    fn a_bad_field_costs_only_itself() {
        let s = parse(r#"{ "fontSize": "huge", "theme": "light", "wrap": false }"#);
        assert_eq!(s.font_size, 15);
        assert_eq!(s.theme, "light");
        assert!(!s.wrap);
    }

    #[test]
    fn auto_save_is_off_unless_asked_for() {
        assert!(!Settings::default().auto_save);
        assert!(!parse(r#"{ "theme": "dark" }"#).auto_save);
        assert!(parse(r#"{ "autoSave": true }"#).auto_save);
        assert!(!parse(r#"{ "autoSave": "yes", "wrap": false }"#).auto_save);
    }

    #[test]
    fn unknown_keys_survive_a_round_trip() {
        let d = scratch("extra");
        let s = parse(r#"{ "theme": "dark", "fromTheFuture": { "a": 1 } }"#);
        save_to(&d, &s).unwrap();
        let back = load_from(&d);
        assert_eq!(back.extra.get("fromTheFuture"), Some(&serde_json::json!({ "a": 1 })));
        assert_eq!(back.theme, "dark");
    }

    #[test]
    fn words_are_sorted_unique_and_skip_comments() {
        let d = scratch("words");
        std::fs::write(d.join("dictionary.txt"), "# c\nzeta\n\nalpha\nzeta\n  beta  \n").unwrap();
        assert_eq!(words_from(&d), vec!["alpha", "beta", "zeta"]);
        save_words_to(&d, &words_from(&d)).unwrap();
        assert_eq!(words_from(&d), vec!["alpha", "beta", "zeta"]);
    }

    #[test]
    fn recent_promotes_dedups_and_caps() {
        let mut r: Vec<String> = Vec::new();
        for i in 0..RECENT_MAX + 5 {
            push_recent(&mut r, format!("/f{i}.md"));
        }
        assert_eq!(r.len(), RECENT_MAX);
        assert_eq!(r[0], format!("/f{}.md", RECENT_MAX + 4));
        // Reopening an existing file moves it to the front, once.
        push_recent(&mut r, "/f10.md".into());
        assert_eq!(r[0], "/f10.md");
        assert_eq!(r.iter().filter(|p| *p == "/f10.md").count(), 1);
        assert_eq!(r.len(), RECENT_MAX);
    }

    #[test]
    fn recent_survives_a_round_trip() {
        let d = scratch("recent");
        let mut r = Vec::new();
        push_recent(&mut r, "/a.md".into());
        push_recent(&mut r, "/b.md".into());
        save_recent_to(&d, &r).unwrap();
        assert_eq!(recent_from(&d), vec!["/b.md", "/a.md"]);
    }

    #[test]
    fn recent_of_a_missing_or_bad_file_is_empty() {
        let d = scratch("recent-bad");
        assert!(recent_from(&d).is_empty());
        std::fs::write(d.join("recent.json"), "{ not a list").unwrap();
        assert!(recent_from(&d).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_keeps_symlinks_and_modes() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let d = scratch("atomic");
        let real = d.join("real.md");
        std::fs::write(&real, "old").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o640)).unwrap();
        let link = d.join("link.md");
        symlink(&real, &link).unwrap();
        write_atomic(&link, b"new").unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "new");
        assert_eq!(std::fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o640);
    }
}
