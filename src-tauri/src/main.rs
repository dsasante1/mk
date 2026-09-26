#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! mk: a Markdown viewer and editor with Harper built in.
//!
//! The Rust half is small on purpose. It owns what a webview cannot: the
//! disk, the settings directory, and Harper, which runs in process on its own
//! thread (`grammar.rs`). Rendering, editing and every decision about what to
//! show live in the TypeScript under `src/`.

mod grammar;
mod settings;

use grammar::{Config, Grammar, Issue, Rule};
use serde::Serialize;
use settings::Settings;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{Manager, State};

/// Larger files are refused rather than opened. The document crosses the IPC
/// bridge as one JSON string on open and on every save, and is re-linted and
/// re-rendered as a whole after each pause in typing; past a few megabytes
/// that is an editor that stutters, and no one writes prose that long.
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

struct AppState {
    grammar: Grammar,
    dir: PathBuf,
    settings: Mutex<Settings>,
    words: Mutex<Vec<String>>,
    ignored: Mutex<BTreeMap<String, BTreeSet<String>>>,
}

fn config_of(s: &Settings, words: &[String]) -> Config {
    Config { dialect: grammar::dialect_from(&s.dialect), rules: s.rules.clone(), words: words.to_vec() }
}

impl AppState {
    fn reconfigure(&self) {
        let s = self.settings.lock().unwrap().clone();
        let words = self.words.lock().unwrap().clone();
        self.grammar.configure(config_of(&s, &words));
    }
}

#[derive(Serialize)]
struct Launch {
    path: Option<String>,
    view: Option<String>,
}

/// What the command line asked for: `mk notes.md`, `mk --view README.md`.
/// A path that does not exist is still a path — it is the file the first save
/// creates, which is what `vim new.md` has taught everyone to expect.
fn parse_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Launch {
    let mut out = Launch { path: None, view: None };
    for a in args {
        match a.as_str() {
            "-v" | "--view" => out.view = Some("preview".into()),
            "-e" | "--edit" => out.view = Some("edit".into()),
            "-s" | "--split" => out.view = Some("split".into()),
            s if s.starts_with('-') => {}
            s if out.path.is_none() => {
                let p = PathBuf::from(s);
                let p = if p.is_absolute() { p } else { cwd.join(p) };
                out.path = Some(std::fs::canonicalize(&p).unwrap_or(p).to_string_lossy().to_string());
            }
            _ => {}
        }
    }
    out
}

#[tauri::command]
fn launch() -> Launch {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    parse_args(std::env::args().skip(1), &cwd)
}

#[derive(Serialize)]
struct Doc {
    path: String,
    content: String,
    mtime: Option<u64>,
}

fn mtime_of(path: &Path) -> Option<u64> {
    let m = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(m.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// Let the preview load images from beside the document, and nowhere else.
fn allow_assets(app: &tauri::AppHandle, doc: &Path) {
    if let Some(dir) = doc.parent() {
        let _ = app.asset_protocol_scope().allow_directory(dir, true);
    }
}

#[tauri::command]
fn read_file(app: tauri::AppHandle, path: String) -> Result<Doc, String> {
    let p = std::fs::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?;
    let meta = std::fs::metadata(&p).map_err(|e| format!("{path}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("{path} is a folder"));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "{path} is {:.1} MB; mk opens files up to {} MB",
            meta.len() as f64 / 1_048_576.0,
            MAX_FILE_BYTES / 1_048_576
        ));
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("{path}: {e}"))?;
    // A NUL in the first block is the usual sign of a binary file, and
    // opening one as text and saving it back would destroy it.
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Err(format!("{path} looks like a binary file"));
    }
    let content = String::from_utf8(bytes).map_err(|_| format!("{path} is not UTF-8 text"))?;
    // A byte-order mark is kept out of the editor, where it would be an
    // invisible first character that every edit at the top trips over.
    let content = content.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(content);
    allow_assets(&app, &p);
    Ok(Doc { mtime: mtime_of(&p), path: p.to_string_lossy().to_string(), content })
}

#[tauri::command]
fn write_file(app: tauri::AppHandle, path: String, content: String) -> Result<Option<u64>, String> {
    let p = PathBuf::from(&path);
    settings::write_atomic(&p, content.as_bytes())?;
    allow_assets(&app, &p);
    Ok(mtime_of(&std::fs::canonicalize(&p).unwrap_or(p)))
}

#[tauri::command]
fn file_mtime(path: String) -> Option<u64> {
    mtime_of(Path::new(&path))
}

#[tauri::command]
async fn lint(state: State<'_, AppState>, text: String) -> Result<Vec<Issue>, String> {
    let g = state.grammar.clone();
    tauri::async_runtime::spawn_blocking(move || g.lint(text)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn grammar_rules(state: State<'_, AppState>) -> Result<Vec<Rule>, String> {
    let g = state.grammar.clone();
    tauri::async_runtime::spawn_blocking(move || g.rules()).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_get(state: State<'_, AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn settings_set(state: State<'_, AppState>, value: Settings) -> Result<(), String> {
    let grammar_changed = {
        let mut cur = state.settings.lock().unwrap();
        let changed = cur.dialect != value.dialect || cur.rules != value.rules;
        *cur = value;
        settings::save_to(&state.dir, &cur)?;
        changed
    };
    if grammar_changed {
        state.reconfigure();
    }
    Ok(())
}

#[tauri::command]
fn words_get(state: State<'_, AppState>) -> Vec<String> {
    state.words.lock().unwrap().clone()
}

#[tauri::command]
fn word_add(state: State<'_, AppState>, word: String) -> Result<Vec<String>, String> {
    let word = word.trim().to_string();
    if word.is_empty() || word.contains(char::is_whitespace) {
        return Err("A dictionary entry is a single word".into());
    }
    let list = {
        let mut w = state.words.lock().unwrap();
        if !w.contains(&word) {
            w.push(word);
            w.sort_by_key(|s| s.to_lowercase());
        }
        settings::save_words_to(&state.dir, &w)?;
        w.clone()
    };
    state.reconfigure();
    Ok(list)
}

#[tauri::command]
fn word_remove(state: State<'_, AppState>, word: String) -> Result<Vec<String>, String> {
    let list = {
        let mut w = state.words.lock().unwrap();
        w.retain(|x| x != &word);
        settings::save_words_to(&state.dir, &w)?;
        w.clone()
    };
    state.reconfigure();
    Ok(list)
}

#[tauri::command]
fn ignored_get(state: State<'_, AppState>, path: String) -> Vec<String> {
    state.ignored.lock().unwrap().get(&path).map(|s| s.iter().cloned().collect()).unwrap_or_default()
}

#[tauri::command]
fn ignore_add(state: State<'_, AppState>, path: String, hash: String) -> Result<(), String> {
    let mut m = state.ignored.lock().unwrap();
    m.entry(path).or_default().insert(hash);
    settings::save_ignored_to(&state.dir, &m)
}

#[tauri::command]
fn ignore_clear(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let mut m = state.ignored.lock().unwrap();
    if m.remove(&path).is_some() {
        settings::save_ignored_to(&state.dir, &m)?;
    }
    Ok(())
}

#[derive(Serialize)]
struct About {
    version: &'static str,
    harper: &'static str,
    config_dir: String,
}

#[tauri::command]
fn about(state: State<'_, AppState>) -> About {
    About {
        version: env!("CARGO_PKG_VERSION"),
        harper: harper_core::core_version(),
        config_dir: state.dir.to_string_lossy().to_string(),
    }
}

fn main() {
    let dir = settings::dir();
    let s = settings::load_from(&dir);
    let words = settings::words_from(&dir);
    let state = AppState {
        grammar: Grammar::start(config_of(&s, &words)),
        ignored: Mutex::new(settings::ignored_from(&dir)),
        settings: Mutex::new(s),
        words: Mutex::new(words),
        dir,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            launch, read_file, write_file, file_mtime, lint, grammar_rules,
            settings_get, settings_set, words_get, word_add, word_remove,
            ignored_get, ignore_add, ignore_clear, about,
        ])
        .run(tauri::generate_context!())
        .expect("error while running mk");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Launch {
        parse_args(v.iter().map(|s| s.to_string()), Path::new("/tmp/nowhere-mk"))
    }

    #[test]
    fn launch_flags() {
        let l = args(&["--view", "notes.md"]);
        assert_eq!(l.view.as_deref(), Some("preview"));
        assert_eq!(l.path.as_deref(), Some("/tmp/nowhere-mk/notes.md"));
        let l = args(&["/abs/a.md", "b.md", "--bogus"]);
        assert_eq!(l.path.as_deref(), Some("/abs/a.md"));
        assert!(l.view.is_none());
        assert!(args(&[]).path.is_none());
    }
}
