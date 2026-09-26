//! Harper, in process, on a thread of its own.
//!
//! The engine lives on one worker thread for its whole life. `LintGroup`
//! caches per chunk and per sentence, which is what makes the second lint of
//! a document a millisecond instead of forty, and that cache only pays if the
//! same group sees every request. It is also why the group is rebuilt rather
//! than reconfigured when the dictionary changes: the group holds the
//! dictionary it was built with.
//!
//! Requests are answered newest-first. When the thread wakes it drains the
//! queue, applies every configuration change in order, and lints only the
//! last document — the earlier ones are answered "superseded", because a lint
//! of text the editor no longer holds is not a late result, it is a wrong one.
//!
//! Everything that crosses back to the webview is in UTF-16 code units.
//! Harper's spans count `char`s; CodeMirror counts what JavaScript strings
//! count. The two agree until the first emoji or astral CJK character, after
//! which every underline in the rest of the document would sit one unit to the
//! left of its word — so the conversion happens here, once, where it is tested.

use harper_core::linting::{Lint, LintGroup, LintKind, Suggestion};
use harper_core::spell::{FstDictionary, MergedDictionary, MutableDictionary};
use harper_core::{Dialect, DictWordMetadata, Document, LintContext};
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;

/// What the engine needs to know that is not the document.
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub dialect: Dialect,
    /// Rule overrides by Harper's own rule name. Absent means Harper's
    /// curated default, so an upgrade that adds a rule turns it on without
    /// the settings file having to know it exists.
    pub rules: BTreeMap<String, bool>,
    pub words: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self { dialect: Dialect::American, rules: BTreeMap::new(), words: Vec::new() }
    }
}

pub fn dialect_from(name: &str) -> Dialect {
    match name.to_ascii_lowercase().as_str() {
        "british" => Dialect::British,
        "canadian" => Dialect::Canadian,
        "australian" => Dialect::Australian,
        "indian" => Dialect::Indian,
        _ => Dialect::American,
    }
}

/// One edit that resolves an issue, already resolved to a range: the webview
/// applies it as a single change without knowing Harper's suggestion kinds.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Fix {
    pub label: String,
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Issue {
    pub from: usize,
    pub to: usize,
    pub rule: String,
    pub kind: String,
    pub message: String,
    /// The flagged text, so the webview can offer "add to dictionary" without
    /// slicing a document that may have moved on since.
    pub text: String,
    pub fixes: Vec<Fix>,
    /// Harper's own location-agnostic identity for this lint: the lint plus
    /// the words around it. Ignoring by this survives edits elsewhere in the
    /// file, where ignoring by position would not survive one keystroke.
    /// A string because a u64 does not fit a JavaScript number.
    pub hash: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Rule {
    pub name: String,
    pub description: String,
    pub enabled: bool,
}

type Reply = Sender<Result<Vec<Issue>, String>>;

enum Job {
    Lint { text: String, reply: Reply },
    Configure(Config),
    Rules(Sender<Vec<Rule>>),
}

#[derive(Clone)]
pub struct Grammar {
    tx: Sender<Job>,
}

impl Grammar {
    pub fn start(config: Config) -> Self {
        let (tx, rx) = channel();
        std::thread::Builder::new()
            .name("harper".into())
            .spawn(move || worker(rx, config))
            .expect("spawn the harper thread");
        Self { tx }
    }

    /// Blocks until the lint is done or superseded. Call it off the main
    /// thread.
    pub fn lint(&self, text: String) -> Result<Vec<Issue>, String> {
        let (reply, rx) = channel();
        self.tx.send(Job::Lint { text, reply }).map_err(|_| "the grammar thread has stopped".to_string())?;
        rx.recv().map_err(|_| "the grammar thread has stopped".to_string())?
    }

    pub fn configure(&self, config: Config) {
        let _ = self.tx.send(Job::Configure(config));
    }

    pub fn rules(&self) -> Vec<Rule> {
        let (reply, rx) = channel();
        if self.tx.send(Job::Rules(reply)).is_err() {
            return Vec::new();
        }
        rx.recv().unwrap_or_default()
    }
}

struct Engine {
    dict: Arc<MergedDictionary>,
    group: LintGroup,
    config: Config,
}

impl Engine {
    fn new(config: Config) -> Self {
        let mut user = MutableDictionary::new();
        for w in &config.words {
            user.append_word_str(w, DictWordMetadata::default());
        }
        let mut merged = MergedDictionary::new();
        merged.add_dictionary(FstDictionary::curated());
        merged.add_dictionary(Arc::new(user));
        let dict = Arc::new(merged);
        let mut group = LintGroup::new_curated(dict.clone(), config.dialect);
        for (name, on) in &config.rules {
            // A rule a newer settings file names and this Harper lacks is
            // skipped, not added: an unknown key in the config is a rule that
            // silently never runs, which reads as a working override.
            if group.contains_key(name) {
                group.config.set_rule_enabled(name, *on);
            }
        }
        Self { dict, group, config }
    }

    fn reconfigure(&mut self, config: Config) {
        if config != self.config {
            *self = Self::new(config);
        }
    }

    fn lint(&mut self, text: &str) -> Vec<Issue> {
        let doc = Document::new_markdown_default(text, &*self.dict);
        let source = doc.get_source();
        let utf16 = Utf16Map::new(source);
        let mut out = Vec::new();
        for (rule, lints) in self.group.organized_lints(&doc) {
            for lint in lints {
                if let Some(issue) = issue(&rule, &lint, &doc, &utf16) {
                    out.push(issue);
                }
            }
        }
        out.sort_by(|a, b| (a.from, a.to, &a.rule).cmp(&(b.from, b.to, &b.rule)));
        out
    }

    fn rules(&self) -> Vec<Rule> {
        let descriptions = self.group.all_descriptions();
        let mut out: Vec<Rule> = self
            .group
            .iter_keys()
            .map(|name| Rule {
                name: name.to_string(),
                description: descriptions.get(name).map(|d| d.to_string()).unwrap_or_default(),
                enabled: self.group.config.is_rule_enabled(name),
            })
            .collect();
        out.sort_by_key(|r| r.name.to_lowercase());
        out.dedup_by(|a, b| a.name == b.name);
        out
    }
}

fn worker(rx: Receiver<Job>, config: Config) {
    let mut engine = Engine::new(config);
    while let Ok(first) = rx.recv() {
        let mut latest: Option<(String, Reply)> = None;
        let mut job = Some(first);
        while let Some(j) = job {
            match j {
                Job::Configure(c) => engine.reconfigure(c),
                Job::Rules(reply) => { let _ = reply.send(engine.rules()); }
                Job::Lint { text, reply } => {
                    if let Some((_, old)) = latest.replace((text, reply)) {
                        let _ = old.send(Err("superseded".into()));
                    }
                }
            }
            job = rx.try_recv().ok();
        }
        if let Some((text, reply)) = latest {
            // A panic inside Harper on one odd document must not end checking
            // for the rest of the session, which is what a dead thread would
            // mean. The engine may be half-way through mutating its caches,
            // so it is rebuilt rather than trusted.
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| engine.lint(&text))) {
                Ok(issues) => { let _ = reply.send(Ok(issues)); }
                Err(_) => {
                    let _ = reply.send(Err("Harper failed on this document".into()));
                    engine = Engine::new(engine.config.clone());
                }
            }
        }
    }
}

fn issue(rule: &str, lint: &Lint, doc: &Document, utf16: &Utf16Map) -> Option<Issue> {
    let source = doc.get_source();
    let (start, end) = (lint.span.start.min(source.len()), lint.span.end.min(source.len()));
    if start > end {
        return None;
    }
    let (from, to) = (utf16.at(start), utf16.at(end));
    let text: String = source[start..end].iter().collect();
    let fixes = lint
        .suggestions
        .iter()
        .map(|s| match s {
            Suggestion::ReplaceWith(chars) => {
                let insert: String = chars.iter().collect();
                Fix { label: format!("Replace with “{insert}”"), from, to, insert }
            }
            Suggestion::InsertAfter(chars) => {
                let insert: String = chars.iter().collect();
                Fix { label: format!("Insert “{insert}”"), from: to, to, insert }
            }
            Suggestion::Remove => Fix { label: format!("Remove “{text}”"), from, to, insert: String::new() },
        })
        .collect();
    Some(Issue {
        from,
        to,
        rule: rule.to_string(),
        kind: kind_name(lint.lint_kind),
        message: lint.message.clone(),
        text,
        fixes,
        hash: LintContext::from_lint(lint, doc).default_hash().to_string(),
    })
}

fn kind_name(kind: LintKind) -> String {
    kind.to_string_key()
}

/// `char` index → UTF-16 offset, for every boundary in the document.
///
/// A prefix table rather than a walk per span: a long document with many
/// issues would otherwise be quadratic in exactly the case — lots of text,
/// lots of findings — where speed is noticed.
struct Utf16Map(Vec<usize>);

impl Utf16Map {
    fn new(chars: &[char]) -> Self {
        let mut v = Vec::with_capacity(chars.len() + 1);
        let mut at = 0;
        v.push(0);
        for c in chars {
            at += c.len_utf16();
            v.push(at);
        }
        Self(v)
    }

    fn at(&self, char_index: usize) -> usize {
        self.0[char_index.min(self.0.len() - 1)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lint(config: Config, text: &str) -> Vec<Issue> {
        Engine::new(config).lint(text)
    }

    #[test]
    fn finds_spelling_and_grammar() {
        let issues = lint(Config::default(), "This is an test. I has a apple.\n");
        let rules: Vec<&str> = issues.iter().map(|i| i.rule.as_str()).collect();
        assert!(rules.contains(&"AnA"), "{rules:?}");
        let an = issues.iter().find(|i| i.text == "an").unwrap();
        assert_eq!(an.fixes[0].insert, "a");
    }

    #[test]
    fn code_is_not_prose() {
        let issues = lint(Config::default(), "Fine text.\n\n```\nlet teh = qwzx;\n```\n\nInline `qwzxv` too.\n");
        assert!(issues.iter().all(|i| i.text != "teh" && i.text != "qwzx" && i.text != "qwzxv"), "{issues:?}");
    }

    #[test]
    fn offsets_are_utf16() {
        // The emoji is one char and two UTF-16 units; the misspelling after
        // it must be reported where JavaScript will look for it.
        let text = "Party 🎉 tonite is fun.\n";
        let issues = lint(Config::default(), text);
        let bad = issues.iter().find(|i| i.text == "tonite").expect("flagged");
        let js: Vec<u16> = text.encode_utf16().collect();
        assert_eq!(String::from_utf16(&js[bad.from..bad.to]).unwrap(), "tonite");
    }

    #[test]
    fn user_words_are_not_misspelled() {
        let text = "The flurbwidget works.\n";
        assert!(lint(Config::default(), text).iter().any(|i| i.text == "flurbwidget"));
        let config = Config { words: vec!["flurbwidget".into()], ..Config::default() };
        assert!(!lint(config, text).iter().any(|i| i.text == "flurbwidget"));
    }

    #[test]
    fn a_disabled_rule_is_silent() {
        let text = "This is an test.\n";
        let mut rules = BTreeMap::new();
        rules.insert("AnA".to_string(), false);
        let config = Config { rules, ..Config::default() };
        assert!(!lint(config, text).iter().any(|i| i.rule == "AnA"));
    }

    #[test]
    fn an_unknown_rule_is_ignored() {
        let mut rules = BTreeMap::new();
        rules.insert("NoSuchRuleInThisHarper".to_string(), true);
        let engine = Engine::new(Config { rules, ..Config::default() });
        assert!(!engine.rules().iter().any(|r| r.name == "NoSuchRuleInThisHarper"));
    }

    #[test]
    fn the_hash_survives_edits_elsewhere() {
        let a = lint(Config::default(), "This is an test.\n");
        let b = lint(Config::default(), "Some new opening line.\n\nThis is an test.\n");
        let ha = &a.iter().find(|i| i.rule == "AnA").unwrap().hash;
        let hb = &b.iter().find(|i| i.rule == "AnA").unwrap().hash;
        assert_eq!(ha, hb);
    }

    #[test]
    fn remove_and_insert_fixes_are_ranges() {
        let issues = lint(Config::default(), "They left and and went home.\n");
        let rep = issues.iter().find(|i| i.rule == "RepeatedWords").expect("repeat flagged");
        let fix = &rep.fixes[0];
        let mut s: Vec<u16> = "They left and and went home.\n".encode_utf16().collect();
        s.splice(fix.from..fix.to, fix.insert.encode_utf16());
        assert_eq!(String::from_utf16(&s).unwrap(), "They left and went home.\n");
    }

    #[test]
    fn stale_lints_are_superseded() {
        let g = Grammar::start(Config::default());
        // Warm the engine so both requests below queue behind one job.
        g.lint("Warm.\n".into()).unwrap();
        let (r1, rx1) = channel();
        let (r2, rx2) = channel();
        g.tx.send(Job::Lint { text: "First.\n".into(), reply: r1 }).unwrap();
        g.tx.send(Job::Lint { text: "Second.\n".into(), reply: r2 }).unwrap();
        let first = rx1.recv().unwrap();
        let second = rx2.recv().unwrap();
        // The first may have been taken alone before the second arrived;
        // what must never happen is the second being dropped.
        assert!(second.is_ok());
        if let Err(e) = first { assert_eq!(e, "superseded"); }
    }

    #[test]
    fn dialect_names() {
        assert_eq!(dialect_from("British"), Dialect::British);
        assert_eq!(dialect_from("nonsense"), Dialect::American);
    }
}
