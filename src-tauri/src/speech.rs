//! Read aloud: finding piper and its voices, turning one sentence into a WAV,
//! the rules file beside a document, and where each document was left.
//!
//! The audio is made here and played by the webview. An `<audio>` element
//! pauses mid-word, changes speed without a resynthesis and works the same on
//! every platform, so there is no audio library on this side and nothing for
//! the build to link against. The webview's own speech is the fallback when
//! piper is not installed; that choice is made in `src/speech-engine.ts`.
//!
//! piper is not bundled. It is a separate program with voice models of tens of
//! megabytes each, and most people who want it have it already (on Linux the
//! Pied app installs it); mk looks where it usually lives.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

/// The rules file mk looks for beside a document and in each folder above it.
pub const RULES_FILE: &str = ".mk-speech.json";
/// A rules file is a page of regular expressions; anything bigger is a mistake.
const MAX_RULES_BYTES: u64 = 256 * 1024;
/// How many documents' places to remember.
pub const PLACES_MAX: usize = 200;
/// One sentence is short; this only has to catch a piper that hangs.
const SAY_TIMEOUT_SECS: u64 = 120;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Voice {
    /// The model's file name without `.onnx`, e.g. `en_US-ryan-high`.
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Debug)]
pub struct Info {
    /// The piper program in use, if one was found.
    pub piper: Option<String>,
    pub voices: Vec<Voice>,
}

#[derive(Serialize)]
pub struct RulesFile {
    pub path: String,
    pub text: String,
}

/// Where a document was left: the sentence's index, and its text, so the place
/// can be found again after the document has been edited above it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub path: String,
    pub sentence: u32,
    pub text: String,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn expand_tilde(p: &str) -> PathBuf {
    match (p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")), home()) {
        (Some(rest), Some(h)) => h.join(rest),
        _ => PathBuf::from(p),
    }
}

fn is_program(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    true
}

const PROGRAM: &str = if cfg!(windows) { "piper.exe" } else { "piper" };

fn on_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(PROGRAM)).find(|p| is_program(p))
}

/// Where piper is usually put, besides `PATH`. The first is the Pied app's
/// copy, which is how most Linux desktops get piper and its voices.
fn usual_programs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(h) = home {
        out.push(h.join(".var/app/com.mikeasoft.pied/data/pied/piper").join(PROGRAM));
        out.push(h.join(".local/share/piper").join(PROGRAM));
        out.push(h.join(".local/bin").join(PROGRAM));
        out.push(h.join("piper").join(PROGRAM));
        out.push(h.join("Library/Application Support/piper").join(PROGRAM));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty()) {
        out.push(PathBuf::from(local).join("piper").join(PROGRAM));
    }
    for d in ["/opt/piper", "/usr/local/bin", "/opt/homebrew/bin"] {
        out.push(Path::new(d).join(PROGRAM));
    }
    out
}

/// The piper program: the one named in Settings if any (and nothing else, so a
/// wrong path is reported rather than quietly worked around), else `PATH`,
/// else the usual places.
pub fn find_piper(setting: &str) -> Option<PathBuf> {
    let setting = setting.trim();
    if !setting.is_empty() {
        let p = expand_tilde(setting);
        return is_program(&p).then_some(p);
    }
    on_path().or_else(|| usual_programs(home().as_deref()).into_iter().find(|p| is_program(p)))
}

/// Folders that hold voice models, most specific first.
pub fn voice_dirs(config_dir: &Path, piper: Option<&Path>) -> Vec<PathBuf> {
    let mut out = vec![config_dir.join("voices")];
    if let Some(h) = home() {
        out.push(h.join(".var/app/com.mikeasoft.pied/data/pied/models"));
        out.push(h.join(".local/share/piper"));
        out.push(h.join(".local/share/piper-voices"));
        out.push(h.join("Library/Application Support/piper"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty()) {
        out.push(PathBuf::from(local).join("piper"));
    }
    out.push(PathBuf::from("/usr/share/piper-voices"));
    out.push(PathBuf::from("/usr/local/share/piper-voices"));
    if let Some(dir) = piper.and_then(Path::parent) {
        out.push(dir.to_path_buf());
        out.push(dir.join("voices"));
    }
    out
}

/// Every voice model under `dirs`. A model counts only with its config beside
/// it (`x.onnx.json`), because piper will not load one without it. The
/// `piper-voices` layout nests models three folders deep, so the walk goes four.
pub fn find_voices(dirs: &[PathBuf]) -> Vec<Voice> {
    fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                if depth > 0 {
                    walk(&p, depth - 1, out);
                }
            } else if p.extension().is_some_and(|x| x == "onnx") {
                let mut config = p.clone().into_os_string();
                config.push(".json");
                if Path::new(&config).is_file() {
                    out.push(p);
                }
            }
        }
    }
    let mut found = Vec::new();
    for d in dirs {
        walk(d, 4, &mut found);
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut voices: Vec<Voice> = found
        .into_iter()
        .filter(|p| seen.insert(std::fs::canonicalize(p).unwrap_or_else(|_| p.clone())))
        .map(|p| Voice {
            name: p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
            path: p.to_string_lossy().to_string(),
        })
        .collect();
    voices.sort_by(|a, b| a.name.cmp(&b.name).then(a.path.cmp(&b.path)));
    voices
}

pub fn info(piper_setting: &str, config_dir: &Path) -> Info {
    let piper = find_piper(piper_setting);
    let voices = find_voices(&voice_dirs(config_dir, piper.as_deref()));
    Info { piper: piper.map(|p| p.to_string_lossy().to_string()), voices }
}

static CLIP: AtomicU64 = AtomicU64::new(0);

/// One utterance as WAV bytes. The text goes in on stdin as a single line:
/// piper treats each line as its own utterance, and a sentence that wrapped in
/// the source should still be read as one.
pub fn synthesize(piper: &Path, model: &Path, text: &str) -> Result<Vec<u8>, String> {
    if model.extension().is_none_or(|x| x != "onnx") || !model.is_file() {
        return Err(format!("{} is not a piper voice", model.display()));
    }
    let line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return Err("nothing to say".into());
    }
    let out = std::env::temp_dir().join(format!(
        "mk-speech-{}-{}.wav",
        std::process::id(),
        CLIP.fetch_add(1, Ordering::Relaxed)
    ));
    let mut cmd = Command::new(piper);
    cmd.arg("--model").arg(model).arg("--output_file").arg(&out);
    cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up per sentence
    }
    let result = (|| {
        let mut child = cmd.spawn().map_err(|e| format!("{}: {e}", piper.display()))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(line.as_bytes()).and_then(|_| stdin.write_all(b"\n")).map_err(|e| e.to_string())?;
        }
        // Read stderr on its own thread so a chatty piper cannot fill the pipe
        // and stall while we wait.
        let mut stderr = child.stderr.take();
        let reader = std::thread::spawn(move || {
            let mut s = String::new();
            if let Some(e) = stderr.as_mut() {
                let _ = std::io::Read::read_to_string(e, &mut s);
            }
            s
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(SAY_TIMEOUT_SECS);
        let status = loop {
            if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
                break s;
            }
            if std::time::Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err("piper took too long".to_string());
            }
            std::thread::sleep(std::time::Duration::from_millis(15));
        };
        let err = reader.join().unwrap_or_default();
        if !status.success() {
            let tail: String = err.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" ");
            return Err(format!("piper failed: {tail}"));
        }
        std::fs::read(&out).map_err(|e| format!("piper wrote no audio: {e}"))
    })();
    let _ = std::fs::remove_file(&out);
    result
}

/// The nearest rules file: beside the document, else in the closest folder
/// above it. A notes folder keeps one at its top, and every document inside
/// it is read by the same rules.
pub fn find_rules(doc: &Path) -> Option<RulesFile> {
    let mut dir = doc.parent();
    while let Some(d) = dir {
        let p = d.join(RULES_FILE);
        if let Ok(meta) = std::fs::metadata(&p) {
            if meta.is_file() && meta.len() <= MAX_RULES_BYTES {
                if let Ok(text) = std::fs::read_to_string(&p) {
                    return Some(RulesFile { path: p.to_string_lossy().to_string(), text });
                }
            }
        }
        dir = d.parent();
    }
    None
}

pub fn places_from(dir: &Path) -> Vec<Place> {
    std::fs::read_to_string(dir.join("speech-places.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<Place>>(&t).ok())
        .unwrap_or_default()
}

pub fn save_places_to(dir: &Path, places: &[Place]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(places).map_err(|e| e.to_string())?;
    crate::settings::write_atomic(&dir.join("speech-places.json"), text.as_bytes())
}

/// Remember `place` for its document, most recent first, keeping
/// [`PLACES_MAX`]. A place at the very start is the same as none, so it is
/// dropped instead: a document read to the end starts again from the top.
pub fn push_place(places: &mut Vec<Place>, place: Place) {
    places.retain(|p| p.path != place.path);
    if place.sentence > 0 {
        places.insert(0, place);
    }
    places.truncate(PLACES_MAX);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mk-speech-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn voices_need_their_config_and_are_found_nested() {
        let d = scratch("voices");
        let deep = d.join("en/en_GB/alan/medium");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("en_GB-alan-medium.onnx"), b"x").unwrap();
        std::fs::write(deep.join("en_GB-alan-medium.onnx.json"), b"{}").unwrap();
        std::fs::write(d.join("lonely.onnx"), b"x").unwrap(); // no config: not a usable voice
        std::fs::write(d.join("a-voice.onnx"), b"x").unwrap();
        std::fs::write(d.join("a-voice.onnx.json"), b"{}").unwrap();
        let v = find_voices(&[d.clone(), d.clone()]);
        let names: Vec<_> = v.iter().map(|v| v.name.as_str()).collect();
        assert_eq!(names, vec!["a-voice", "en_GB-alan-medium"]);
    }

    #[test]
    fn a_piper_named_in_settings_is_the_only_one_tried() {
        assert_eq!(find_piper("/no/such/piper"), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_program_must_be_executable() {
        use std::os::unix::fs::PermissionsExt;
        let d = scratch("exe");
        let p = d.join("piper");
        std::fs::write(&p, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(find_piper(p.to_str().unwrap()), None);
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(find_piper(p.to_str().unwrap()), Some(p));
    }

    #[test]
    fn only_a_voice_model_is_accepted() {
        let d = scratch("model");
        let not_voice = d.join("notes.md");
        std::fs::write(&not_voice, b"x").unwrap();
        let err = synthesize(Path::new("/bin/true"), &not_voice, "hello").unwrap_err();
        assert!(err.contains("not a piper voice"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn synthesize_sends_one_line_and_returns_the_file() {
        use std::os::unix::fs::PermissionsExt;
        // A stand-in piper: writes what it read on stdin to --output_file.
        let d = scratch("fake-piper");
        let piper = d.join("piper");
        std::fs::write(&piper, "#!/bin/sh\nwhile [ $# -gt 0 ]; do [ \"$1\" = --output_file ] && out=$2; shift; done\ncat > \"$out\"\n").unwrap();
        std::fs::set_permissions(&piper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let model = d.join("v.onnx");
        std::fs::write(&model, b"x").unwrap();
        let bytes = synthesize(&piper, &model, "Two\nlines  of text").unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), "Two lines of text\n");
    }

    #[test]
    fn rules_are_found_in_the_nearest_folder_up() {
        let d = scratch("rules");
        let deep = d.join("notes/company/detailed");
        std::fs::create_dir_all(&deep).unwrap();
        assert!(find_rules(&deep.join("07.md")).is_none());
        std::fs::write(d.join(RULES_FILE), r#"{"words":{}}"#).unwrap();
        let r = find_rules(&deep.join("07.md")).unwrap();
        assert_eq!(Path::new(&r.path), d.join(RULES_FILE));
        std::fs::write(deep.join(RULES_FILE), "{}").unwrap();
        assert_eq!(find_rules(&deep.join("07.md")).unwrap().text, "{}");
    }

    #[test]
    fn places_move_to_the_front_and_the_start_clears() {
        let mut p = Vec::new();
        for i in 0..PLACES_MAX + 3 {
            push_place(&mut p, Place { path: format!("/f{i}.md"), sentence: 5, text: "x".into() });
        }
        assert_eq!(p.len(), PLACES_MAX);
        push_place(&mut p, Place { path: "/f10.md".into(), sentence: 9, text: "y".into() });
        assert_eq!(p[0].sentence, 9);
        assert_eq!(p.iter().filter(|x| x.path == "/f10.md").count(), 1);
        push_place(&mut p, Place { path: "/f10.md".into(), sentence: 0, text: String::new() });
        assert!(p.iter().all(|x| x.path != "/f10.md"));
    }

    #[test]
    fn places_survive_a_round_trip() {
        let d = scratch("places");
        let mut p = Vec::new();
        push_place(&mut p, Place { path: "/a.md".into(), sentence: 3, text: "Third.".into() });
        save_places_to(&d, &p).unwrap();
        assert_eq!(places_from(&d), p);
        std::fs::write(d.join("speech-places.json"), "{ nope").unwrap();
        assert!(places_from(&d).is_empty());
    }
}
