#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! mk: a Markdown viewer and editor with Harper built in.
//!
//! The Rust half is small on purpose. It owns what a webview cannot: the
//! disk, the settings directory, and Harper, which runs in process on its own
//! thread (`grammar.rs`). Rendering, editing and every decision about what to
//! show live in the TypeScript under `src/`.

mod grammar;
mod settings;
mod speech;

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
    recent: Mutex<Vec<String>>,
    places: Mutex<Vec<speech::Place>>,
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
    /// Every file named, in order; each opens in its own tab.
    paths: Vec<String>,
    view: Option<String>,
}

/// What the command line asked for: `mk notes.md`, `mk --view README.md`,
/// `mk a.md b.md`. A file named twice opens once.
/// A path that does not exist is still a path — it is the file the first save
/// creates, which is what `vim new.md` has taught everyone to expect.
/// `canonicalize`, minus the `\\?\` prefix Windows puts on the result. The
/// frontend shows these paths and resolves links against them, and a
/// verbatim path is neither what the user typed nor one `/` can extend.
fn canonical(p: &Path) -> std::io::Result<PathBuf> {
    let c = std::fs::canonicalize(p)?;
    if cfg!(windows) {
        let s = c.to_string_lossy();
        if let Some(unc) = s.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{unc}")));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(c)
}

fn parse_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Launch {
    let mut out = Launch { paths: Vec::new(), view: None };
    for a in args {
        match a.as_str() {
            "-v" | "--view" => out.view = Some("preview".into()),
            "-e" | "--edit" => out.view = Some("edit".into()),
            "-s" | "--split" => out.view = Some("split".into()),
            s if s.starts_with('-') => {}
            s => {
                let p = PathBuf::from(s);
                let p = if p.is_absolute() { p } else { cwd.join(p) };
                let p = canonical(&p).unwrap_or(p).to_string_lossy().to_string();
                if !out.paths.contains(&p) {
                    out.paths.push(p);
                }
            }
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
    let p = canonical(Path::new(&path)).map_err(|e| format!("{path}: {e}"))?;
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
    Ok(mtime_of(&canonical(&p).unwrap_or(p)))
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

#[tauri::command]
fn recent_get(state: State<'_, AppState>) -> Vec<String> {
    state.recent.lock().unwrap().clone()
}

/// A file the frontend just opened. Recorded here, where it can be written to
/// disk, so the menu is the same the next time mk starts.
#[tauri::command]
fn recent_add(state: State<'_, AppState>, path: String) -> Result<Vec<String>, String> {
    let mut r = state.recent.lock().unwrap();
    settings::push_recent(&mut r, path);
    settings::save_recent_to(&state.dir, &r)?;
    Ok(r.clone())
}

#[tauri::command]
fn recent_clear(state: State<'_, AppState>) -> Result<(), String> {
    let mut r = state.recent.lock().unwrap();
    r.clear();
    settings::save_recent_to(&state.dir, &r)
}

// ---------------------------------------------------------------- read aloud

#[tauri::command]
fn speech_info(state: State<'_, AppState>) -> speech::Info {
    let piper = state.settings.lock().unwrap().speech_piper.clone();
    speech::info(&piper, &state.dir)
}

/// One sentence as WAV bytes, sent as raw binary rather than JSON: a sentence
/// of speech is a few hundred kilobytes, and the webview plays it as a blob.
#[tauri::command]
async fn speech_say(state: State<'_, AppState>, text: String, voice: String) -> Result<tauri::ipc::Response, String> {
    let setting = state.settings.lock().unwrap().speech_piper.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let piper = speech::find_piper(&setting).ok_or_else(|| "piper is not installed".to_string())?;
        speech::synthesize(&piper, Path::new(&voice), &text)
    })
    .await
    .map_err(|e| e.to_string())?
    .map(tauri::ipc::Response::new)
}

#[tauri::command]
fn speech_rules(path: String) -> Option<speech::RulesFile> {
    speech::find_rules(Path::new(&path))
}

#[tauri::command]
fn speech_place_get(state: State<'_, AppState>, path: String) -> Option<speech::Place> {
    state.places.lock().unwrap().iter().find(|p| p.path == path).cloned()
}

#[tauri::command]
fn speech_place_set(state: State<'_, AppState>, place: speech::Place) -> Result<(), String> {
    let mut p = state.places.lock().unwrap();
    speech::push_place(&mut p, place);
    speech::save_places_to(&state.dir, &p)
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
        recent: Mutex::new(settings::recent_from(&dir)),
        places: Mutex::new(speech::places_from(&dir)),
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
            ignored_get, ignore_add, ignore_clear, recent_get, recent_add,
            recent_clear, about, speech_info, speech_say, speech_rules,
            speech_place_get, speech_place_set,
        ])
        .run(tauri::generate_context!())
        .expect("error while running mk");
}

#[cfg(test)]
mod tests {
    use super::*;

    // Paths that do not exist, so they come back as built rather than resolved.
    const CWD: &str = if cfg!(windows) { r"C:\nowhere-mk" } else { "/tmp/nowhere-mk" };
    const ABS: &str = if cfg!(windows) { r"C:\abs\a.md" } else { "/abs/a.md" };

    fn args(v: &[&str]) -> Launch {
        parse_args(v.iter().map(|s| s.to_string()), Path::new(CWD))
    }

    fn in_cwd(name: &str) -> String {
        Path::new(CWD).join(name).to_string_lossy().to_string()
    }

    #[test]
    fn launch_flags() {
        let l = args(&["--view", "notes.md"]);
        assert_eq!(l.view.as_deref(), Some("preview"));
        assert_eq!(l.paths, vec![in_cwd("notes.md")]);
        let l = args(&[ABS, "b.md", "--bogus", ABS]);
        assert_eq!(l.paths, vec![ABS.to_string(), in_cwd("b.md")]);
        assert!(l.view.is_none());
        assert!(args(&[]).paths.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn canonical_paths_are_plain() {
        let p = canonical(&std::env::temp_dir()).unwrap();
        assert!(!p.to_string_lossy().starts_with(r"\\?\"), "{}", p.display());
    }
}
