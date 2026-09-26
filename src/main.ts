// mk — the app shell.
//
// One document per window. The editor is the source of truth; the preview and
// Harper both read from it after a pause in typing, and neither ever writes
// to it except through an ordinary, undoable CodeMirror transaction (a fix, a
// ticked checkbox).

import "./styles.css";
import { Text } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { nextDiagnostic, previousDiagnostic } from "@codemirror/lint";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { homeDir } from "@tauri-apps/api/path";
import { open as openDialog, save as saveDialog, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import { api, type Issue, type Settings, type View } from "./api";
import { Editor } from "./editor";
import { Grammar, groupOf, GROUP_LABEL, ruleLabel, type Group } from "./grammar";
import { Preview } from "./preview";
import { SettingsDialog } from "./settings-ui";
import { icons } from "./icons";
import {
  baseName, countWords, detectEol, dirName, isExternal, isMarkdownPath, readingMinutes,
  resolvePath, tildify, toggleTask, withEol, type Eol,
} from "./text";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const win = getCurrentWindow();

const MD_FILTERS = [
  { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "mkdn", "mdx", "txt"] },
  { name: "All files", extensions: ["*"] },
];

// ---------------------------------------------------------------- state

let settings: Settings;
let savingSettings: Promise<void> = Promise.resolve();
let home: string | null = null;

const doc = {
  path: null as string | null,
  eol: "\n" as Eol,
  saved: Text.empty,
  mtime: null as number | null,
  /** Set while our own save is in flight, so the watcher does not see it as someone else's. */
  writing: false,
};

const dirty = () => !editor.doc.eq(doc.saved);

// ---------------------------------------------------------------- toasts

function toast(msg: string, ms = 2600) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  $("toasts").append(el);
  window.setTimeout(() => { el.classList.add("out"); window.setTimeout(() => el.remove(), 300); }, ms);
}

// ---------------------------------------------------------------- theme

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme() {
  const theme = settings.theme === "system" ? (systemDark.matches ? "dark" : "light") : settings.theme;
  document.documentElement.dataset.theme = theme;
  $("btn-theme").innerHTML = theme === "dark" ? icons.sun : icons.moon;
}
systemDark.addEventListener("change", () => applyTheme());

// ---------------------------------------------------------------- settings

function saveSettings() {
  const snapshot = { ...settings };
  savingSettings = savingSettings.then(() => api.settingsSet(snapshot)).catch((e) => toast(`Settings not saved: ${e}`));
}

let saveTimer: number | undefined;
function saveSettingsSoon() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveSettings, 400);
}

function applySettings(next: Settings) {
  const grammarWas = settings?.grammar;
  settings = next;
  applyTheme();
  editor?.apply(settings);
  setView(settings.view, false);
  setProblems(settings.problemsOpen, false);
  if (grammar && grammarWas !== settings.grammar) grammar.setEnabled(settings.grammar);
  updateStatus();
}

// ---------------------------------------------------------------- editor + preview + grammar

let editor: Editor;
let grammar: Grammar;
let previewTimer: number | undefined;

const preview = new Preview($("preview"), $("preview-pane"), {
  toggleTask(line) {
    const n = line + 1;
    if (n > editor.doc.lines) return;
    const l = editor.doc.line(n);
    const edit = toggleTask(l.text);
    if (!edit) return;
    const at = l.from + edit.offset;
    editor.view.dispatch({ changes: { from: at, to: at + 1, insert: edit.insert }, userEvent: "input.task" });
  },
  openLink: (href) => void followLink(href),
});

async function followLink(href: string) {
  if (isExternal(href)) {
    if (/^(https?|mailto):/i.test(href)) await openUrl(href).catch((e) => toast(String(e)));
    else toast(`mk does not open ${href.split(":")[0]}: links`);
    return;
  }
  const dir = preview.directory;
  if (!dir) { toast("Save the document first so relative links have somewhere to start from"); return; }
  const target = resolvePath(dir, href);
  if (isMarkdownPath(target)) {
    await openPath(target);
    const hash = href.split("#")[1];
    if (hash) window.setTimeout(() => preview.scrollToAnchor(hash), 60);
  } else {
    toast(`Not a Markdown file: ${baseName(target)}`);
  }
}

function renderPreview() {
  if (settings.view === "edit") return;
  preview.render(editor.text());
  if (settings.syncScroll && settings.view === "split") syncFrom("editor");
}

function onUpdate(u: ViewUpdate) {
  if (u.docChanged) {
    grammar.changed(u.changes);
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(renderPreview, 120);
    updateTitle();
  }
  if (u.docChanged || u.selectionSet) updateStatus();
}

// ---------------------------------------------------------------- scroll sync
//
// Each pane remembers the scrollTop we last set on it. A scroll event that
// lands there is our own echo and is ignored; anything else is the user, and
// drives the other pane. Without this the two panes chase each other.

const expected = { editor: -1, preview: -1 };

function syncFrom(source: "editor" | "preview") {
  if (!settings.syncScroll || settings.view !== "split") return;
  if (source === "editor") {
    const y = Math.round(preview.heightOfLine(editor.topLine()));
    expected.preview = y;
    preview.pane.scrollTop = y;
  } else {
    const y = Math.round(editor.heightOfLine(preview.topLine()));
    expected.editor = y;
    editor.view.scrollDOM.scrollTop = y;
  }
}

function onScroll(source: "editor" | "preview", el: HTMLElement) {
  if (Math.abs(el.scrollTop - expected[source]) <= 2) { expected[source] = -1; return; }
  expected[source] = -1;
  syncFrom(source);
}

// ---------------------------------------------------------------- view modes

function setView(v: View, persist = true) {
  settings.view = v;
  const ws = $("workspace");
  ws.dataset.view = v;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#view-seg button")) {
    b.classList.toggle("on", b.dataset.view === v);
  }
  applySplit();
  if (v !== "edit") renderPreview();
  if (v !== "preview") editor?.view.requestMeasure();
  if (persist) saveSettingsSoon();
}

function applySplit() {
  const r = Math.min(0.8, Math.max(0.2, settings.split || 0.5));
  $("workspace").style.setProperty("--ratio", String(r));
}

function initDivider() {
  const div = $("divider");
  div.addEventListener("pointerdown", (e) => {
    div.setPointerCapture(e.pointerId);
    document.body.classList.add("dragging");
    const ws = $("workspace");
    const move = (ev: PointerEvent) => {
      const rect = ws.getBoundingClientRect();
      const problems = settings.problemsOpen ? $("problems").getBoundingClientRect().width : 0;
      settings.split = (ev.clientX - rect.left) / Math.max(1, rect.width - problems);
      applySplit();
    };
    const up = () => {
      div.removeEventListener("pointermove", move);
      div.removeEventListener("pointerup", up);
      document.body.classList.remove("dragging");
      saveSettingsSoon();
      editor.view.requestMeasure();
    };
    div.addEventListener("pointermove", move);
    div.addEventListener("pointerup", up);
  });
  div.addEventListener("dblclick", () => { settings.split = 0.5; applySplit(); saveSettingsSoon(); });
}

// ---------------------------------------------------------------- problems panel

let filter: Group | null = null;
let harperState: "checking" | "ready" | "off" | "error" = "checking";

function setProblems(open: boolean, persist = true) {
  settings.problemsOpen = open;
  $("problems").hidden = !open;
  $("workspace").classList.toggle("with-problems", open);
  $("btn-problems").classList.toggle("on", open);
  if (open) renderProblems();
  if (persist) saveSettingsSoon();
}

function counts(issues: Issue[]): Record<Group, number> {
  const c: Record<Group, number> = { spelling: 0, grammar: 0, style: 0 };
  for (const i of issues) c[groupOf(i.kind)]++;
  return c;
}

function renderProblems() {
  const list = $("problem-list");
  const scroll = list.scrollTop;
  const issues = grammar.issues;
  const c = counts(issues);
  $("problems-head").textContent = harperState === "off"
    ? "Harper is off"
    : `${issues.length} issue${issues.length === 1 ? "" : "s"}`;

  const filters = $("problem-filters");
  filters.replaceChildren();
  for (const g of ["spelling", "grammar", "style"] as Group[]) {
    const b = document.createElement("button");
    b.className = `chip hp-${g}${filter === g ? " on" : ""}`;
    b.innerHTML = `<span class="dot"></span>${GROUP_LABEL[g]} <b>${c[g]}</b>`;
    b.onclick = () => { filter = filter === g ? null : g; renderProblems(); };
    filters.append(b);
  }

  list.replaceChildren();
  if (harperState === "off") {
    list.innerHTML = `<div class="empty">Turn Harper on in Settings to check this document.</div>`;
    return;
  }
  const shown = issues.filter((i) => !filter || groupOf(i.kind) === filter).sort((a, b) => a.from - b.from);
  if (shown.length === 0) {
    list.innerHTML = `<div class="empty">${harperState === "checking" && issues.length === 0 ? "Checking…" : "Nothing to fix. Nice writing."}</div>`;
    return;
  }
  for (const issue of shown) {
    const row = document.createElement("div");
    row.className = `problem hp-${groupOf(issue.kind)}`;
    const line = editor.doc.lineAt(Math.min(issue.from, editor.doc.length));
    const head = document.createElement("div");
    head.className = "p-head";
    head.innerHTML = `<span class="dot"></span><span class="p-rule"></span><span class="p-line">Ln ${line.number}</span>`;
    head.querySelector(".p-rule")!.textContent = ruleLabel(issue.rule);
    const msg = document.createElement("div");
    msg.className = "p-msg";
    msg.textContent = issue.message.replace(/`/g, "");
    const ctx = document.createElement("div");
    ctx.className = "p-ctx";
    const col = issue.from - line.from;
    const before = line.text.slice(Math.max(0, col - 28), col);
    const bad = editor.doc.sliceString(issue.from, Math.min(issue.to, line.to));
    const after = line.text.slice(col + bad.length, col + bad.length + 28);
    ctx.append(before, Object.assign(document.createElement("mark"), { textContent: bad || "¶" }), after);
    const acts = document.createElement("div");
    acts.className = "p-actions";
    for (const a of grammar.actions(issue).slice(0, 4)) {
      const b = document.createElement("button");
      b.className = a.kind === "fix" ? "fix" : "";
      b.textContent = a.label;
      b.onclick = (e) => { e.stopPropagation(); a.run(); };
      acts.append(b);
    }
    row.append(head, msg, ctx, acts);
    row.onclick = () => {
      if (settings.view === "preview") setView("split");
      editor.select(issue.from, issue.to);
    };
    list.append(row);
  }
  list.scrollTop = scroll;
}

function updateHarperStatus() {
  const el = $("st-harper");
  const c = counts(grammar.issues);
  const total = grammar.issues.length;
  const btn = $("btn-problems");
  btn.dataset.state = harperState === "off" ? "off" : total === 0 ? "clean" : c.spelling ? "spelling" : c.grammar ? "grammar" : "style";
  if (harperState === "off") {
    el.textContent = "Harper off";
    $("problems-label").textContent = "Harper off";
  } else if (harperState === "error") {
    el.textContent = "Harper failed";
    $("problems-label").textContent = "Harper";
  } else {
    const parts = (["spelling", "grammar", "style"] as Group[]).filter((g) => c[g]).map((g) => `${c[g]} ${GROUP_LABEL[g].toLowerCase()}`);
    el.textContent = total === 0 ? (harperState === "checking" ? "Checking…" : "✓ No issues") : parts.join(" · ");
    $("problems-label").textContent = total === 0 ? "No issues" : `${total} issue${total === 1 ? "" : "s"}`;
  }
}

// ---------------------------------------------------------------- quick fix menu

let qf: { items: { label: string; run: () => void; kind: string }[]; index: number } | null = null;

function openQuickFix() {
  const pos = editor.view.state.selection.main.head;
  const issues = grammar.at(pos);
  if (issues.length === 0) {
    const next = grammar.next(pos, 1);
    if (!next) { toast("Harper has nothing to say here"); return; }
    editor.select(next.from, next.to);
    window.setTimeout(openQuickFix, 30);
    return;
  }
  const issue = issues[0];
  const coords = editor.view.coordsAtPos(issue.from);
  const menu = $("quickfix");
  menu.replaceChildren();
  const head = document.createElement("div");
  head.className = "qf-head";
  head.append(Object.assign(document.createElement("b"), { textContent: ruleLabel(issue.rule) }), " — ", issue.message.replace(/`/g, ""));
  menu.append(head);
  const items = grammar.actions(issue);
  items.forEach((a, n) => {
    const b = document.createElement("button");
    b.className = `qf-item ${a.kind}`;
    b.innerHTML = `<kbd>${n < 9 ? n + 1 : ""}</kbd><span></span>`;
    b.querySelector("span")!.textContent = a.label;
    b.onmouseenter = () => { if (qf) { qf.index = n; paintQuickFix(); } };
    b.onclick = () => { closeQuickFix(); a.run(); };
    menu.append(b);
  });
  qf = { items, index: 0 };
  menu.hidden = false;
  const x = Math.min((coords?.left ?? 100), window.innerWidth - menu.offsetWidth - 12);
  let y = (coords?.bottom ?? 100) + 6;
  if (y + menu.offsetHeight > window.innerHeight - 8) y = (coords?.top ?? 100) - menu.offsetHeight - 6;
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
  paintQuickFix();
}

function paintQuickFix() {
  $("quickfix").querySelectorAll(".qf-item").forEach((el, n) => el.classList.toggle("sel", n === qf?.index));
}

function closeQuickFix() {
  qf = null;
  $("quickfix").hidden = true;
  editor.view.focus();
}

function quickFixKey(e: KeyboardEvent): boolean {
  if (!qf) return false;
  if (e.key === "Escape") { closeQuickFix(); return true; }
  if (e.key === "ArrowDown") { qf.index = (qf.index + 1) % qf.items.length; paintQuickFix(); return true; }
  if (e.key === "ArrowUp") { qf.index = (qf.index - 1 + qf.items.length) % qf.items.length; paintQuickFix(); return true; }
  if (e.key === "Enter") { const a = qf.items[qf.index]; closeQuickFix(); a.run(); return true; }
  if (/^[1-9]$/.test(e.key)) {
    const a = qf.items[Number(e.key) - 1];
    if (a) { closeQuickFix(); a.run(); }
    return true;
  }
  closeQuickFix();
  return false;
}

// ---------------------------------------------------------------- documents

function updateTitle() {
  const name = doc.path ? baseName(doc.path) : "Untitled";
  const d = dirty();
  $("doc-title").textContent = name;
  $("doc-dirty").hidden = !d;
  $("doc-dir").textContent = doc.path ? tildify(dirName(doc.path), home) : "";
  void win.setTitle(`${d ? "● " : ""}${name} — mk`);
}

function updateStatus() {
  if (!editor) return;
  const st = editor.view.state;
  const head = st.selection.main.head;
  const line = st.doc.lineAt(head);
  const sel = st.selection.ranges.reduce((n, r) => n + (r.to - r.from), 0);
  $("st-pos").textContent = `Ln ${line.number}, Col ${head - line.from + 1}${sel ? ` (${sel} selected)` : ""}`;
  window.clearTimeout(wordsTimer);
  wordsTimer = window.setTimeout(() => {
    const w = countWords(editor.text());
    $("st-words").textContent = `${w.toLocaleString()} word${w === 1 ? "" : "s"}`;
    const m = readingMinutes(w);
    $("st-read").textContent = m ? `${m} min read` : "";
  }, 150);
  $("st-eol").textContent = doc.eol === "\n" ? "LF" : "CRLF";
  $("st-dialect").textContent = settings.dialect;
}
let wordsTimer: number | undefined;

/** True when it is fine to throw the current buffer away. */
async function confirmDiscard(action: string): Promise<boolean> {
  if (!dirty()) return true;
  const name = doc.path ? baseName(doc.path) : "Untitled";
  const r = await message(`${name} has unsaved changes.`, {
    title: action,
    kind: "warning",
    buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" },
  });
  if (r === "Save" || r === "Yes") return save();
  return r === "Don't Save" || r === "No";
}

function loadDoc(path: string | null, content: string, mtime: number | null) {
  doc.path = path;
  doc.eol = detectEol(content);
  const text = content.replace(/\r\n?/g, "\n");
  doc.mtime = mtime;
  editor.load(text);
  doc.saved = editor.doc;
  preview.setDir(path ? dirName(path) : null);
  hideBanner();
  updateTitle();
  updateStatus();
  void grammar.reset(path);
  preview.pane.scrollTop = 0;
  if (settings.view !== "edit") preview.render(editor.text());
  editor.view.focus();
}

async function openPath(path: string) {
  if (path === doc.path) return;
  if (!(await confirmDiscard("Open"))) return;
  try {
    const d = await api.readFile(path);
    loadDoc(d.path, d.content, d.mtime);
  } catch (e) {
    const msg = String(e);
    // A path that does not exist yet is a new document to be saved there.
    if (/No such file|not found|os error 2/i.test(msg)) {
      loadDoc(path, "", null);
      toast(`New file — it will be created at ${tildify(path, home)} on save`);
    } else {
      await message(msg, { title: "Could not open", kind: "error" });
    }
  }
}

async function openWithDialog() {
  const picked = await openDialog({ multiple: false, directory: false, filters: MD_FILTERS, defaultPath: doc.path ? dirName(doc.path) : undefined });
  if (typeof picked === "string") await openPath(picked);
}

async function newDoc() {
  if (!(await confirmDiscard("New document"))) return;
  loadDoc(null, "", null);
}

async function save(): Promise<boolean> {
  if (!doc.path) return saveAs();
  return writeTo(doc.path);
}

async function saveAs(): Promise<boolean> {
  const picked = await saveDialog({
    filters: MD_FILTERS,
    defaultPath: doc.path ?? (home ? `${home}/Untitled.md` : "Untitled.md"),
  });
  if (!picked) return false;
  const path = /\.[^/\\]+$/.test(baseName(picked)) ? picked : `${picked}.md`;
  const ok = await writeTo(path);
  if (ok && path !== doc.path) {
    doc.path = path;
    preview.setDir(dirName(path));
    void grammar.reset(path);
    renderPreview();
    updateTitle();
  }
  return ok;
}

async function writeTo(path: string): Promise<boolean> {
  const snapshot = editor.doc;
  doc.writing = true;
  try {
    doc.mtime = await api.writeFile(path, withEol(snapshot.toString(), doc.eol));
    doc.path = path;
    doc.saved = snapshot;
    updateTitle();
    toast(`Saved ${baseName(path)}`, 1400);
    return true;
  } catch (e) {
    await message(String(e), { title: "Could not save", kind: "error" });
    return false;
  } finally {
    doc.writing = false;
  }
}

// ---------------------------------------------------------------- change on disk

function showBanner(text: string, actions: [string, () => void][]) {
  const b = $("banner");
  b.replaceChildren(Object.assign(document.createElement("span"), { textContent: text }));
  for (const [label, run] of actions) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.onclick = () => { hideBanner(); run(); };
    b.append(btn);
  }
  b.hidden = false;
}

function hideBanner() { $("banner").hidden = true; }

async function reloadFromDisk(quiet: boolean) {
  if (!doc.path) return;
  try {
    const d = await api.readFile(doc.path);
    doc.eol = detectEol(d.content);
    editor.replaceKeepingPlace(d.content.replace(/\r\n?/g, "\n"));
    doc.saved = editor.doc;
    doc.mtime = d.mtime;
    updateTitle();
    if (!quiet) toast("Reloaded from disk");
  } catch (e) {
    toast(String(e));
  }
}

/**
 * Polled rather than watched: one stat every two seconds of one file is
 * cheaper than a watcher thread, and it is how a viewer left open beside
 * another editor keeps up. A clean buffer follows the disk silently; a dirty
 * one asks, because either answer loses somebody's work.
 */
async function checkDisk() {
  if (!doc.path || doc.writing || doc.mtime === null || !$("banner").hidden) return;
  const m = await api.fileMtime(doc.path).catch(() => null);
  if (m === null || m === doc.mtime || doc.writing) return;
  if (!dirty()) { await reloadFromDisk(true); return; }
  const seen = m;
  showBanner(`${baseName(doc.path)} changed on disk.`, [
    ["Reload (lose my edits)", () => void reloadFromDisk(false)],
    ["Keep mine", () => { doc.mtime = seen; }],
  ]);
}

// ---------------------------------------------------------------- keys

function onKey(e: KeyboardEvent) {
  if (quickFixKey(e)) { e.preventDefault(); return; }
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const stop = () => { e.preventDefault(); e.stopPropagation(); };

  if (e.key === "Escape") {
    // Esc closes the innermost open thing and is otherwise nothing. It is
    // never how you quit, and never how you lose work.
    if (settingsDialog.open) return;
    if (!$("banner").hidden) { hideBanner(); stop(); }
    return;
  }
  if (mod && !e.shiftKey && k === "s") { stop(); void save(); return; }
  if (mod && e.shiftKey && k === "s") { stop(); void saveAs(); return; }
  if (mod && !e.shiftKey && k === "o") { stop(); void openWithDialog(); return; }
  if (mod && !e.shiftKey && k === "n") { stop(); void newDoc(); return; }
  if (mod && !e.shiftKey && k === "q") { stop(); void win.close(); return; }
  if (mod && !e.shiftKey && e.key === ",") { stop(); void settingsDialog.show(); return; }
  if (mod && !e.shiftKey && (e.key === "1" || e.key === "2" || e.key === "3")) {
    stop(); setView((["edit", "split", "preview"] as View[])[Number(e.key) - 1]); return;
  }
  if (mod && e.shiftKey && k === "m") { stop(); setProblems(!settings.problemsOpen); return; }
  if (mod && e.shiftKey && k === "v") { stop(); setView(settings.view === "preview" ? "split" : "preview"); return; }
  if (mod && (e.key === "=" || e.key === "+")) { stop(); zoom(1); return; }
  if (mod && e.key === "-") { stop(); zoom(-1); return; }
  if (mod && e.key === "0") { stop(); settings.fontSize = 15; applySettings(settings); saveSettingsSoon(); return; }
  if (mod && e.key === ".") { stop(); ensureEditor(); openQuickFix(); return; }
  if (e.key === "F8") {
    stop(); ensureEditor();
    (e.shiftKey ? previousDiagnostic : nextDiagnostic)(editor.view);
    editor.view.focus();
    return;
  }
  if (e.key === "F7") { stop(); toggleTheme(); return; }
}

function ensureEditor() {
  if (settings.view === "preview") setView("split");
}

function zoom(d: number) {
  settings.fontSize = Math.min(28, Math.max(10, settings.fontSize + d));
  applySettings(settings);
  saveSettingsSoon();
}

function toggleTheme() {
  const now = document.documentElement.dataset.theme;
  settings.theme = now === "dark" ? "light" : "dark";
  applyTheme();
  saveSettingsSoon();
}

// ---------------------------------------------------------------- boot

let settingsDialog: SettingsDialog;

async function boot() {
  settings = await api.settingsGet();
  home = await homeDir().then((h) => h.replace(/\/$/, "")).catch(() => null);
  applyTheme();

  editor = new Editor($("editor-pane"), settings, [], {
    onUpdate,
    keys: [],
  });
  grammar = new Grammar(() => editor.view, {
    path: () => doc.path,
    onIssues(_issues, state) {
      harperState = state;
      updateHarperStatus();
      if (settings.problemsOpen) renderProblems();
    },
    async disableRule(rule) {
      settings.rules = { ...settings.rules, [rule]: false };
      saveSettings();
      await savingSettings;
    },
    toast,
  });
  grammar.enabled = settings.grammar;

  settingsDialog = new SettingsDialog($("settings") as HTMLDialogElement, {
    current: () => settings,
    onChange(s) {
      applySettings(s);
      saveSettings();
    },
    relint() { void savingSettings.then(() => grammar.schedule(0)); },
    ignoredCount: () => grammar.ignoredCount,
    clearIgnored: () => void grammar.clearIgnored(),
  });

  // chrome
  $("btn-new").innerHTML = icons.newFile;
  $("btn-open").innerHTML = icons.open;
  $("btn-save").innerHTML = icons.save;
  $("btn-settings").innerHTML = icons.settings;
  $("btn-problems-close").innerHTML = icons.close;
  $("btn-new").onclick = () => void newDoc();
  $("btn-open").onclick = () => void openWithDialog();
  $("btn-save").onclick = () => void save();
  $("btn-settings").onclick = () => void settingsDialog.show();
  $("btn-theme").onclick = toggleTheme;
  $("btn-problems").onclick = () => setProblems(!settings.problemsOpen);
  $("btn-problems-close").onclick = () => setProblems(false);
  $("st-harper").onclick = () => setProblems(!settings.problemsOpen);
  $("st-dialect").onclick = () => void settingsDialog.show();
  for (const b of document.querySelectorAll<HTMLButtonElement>("#view-seg button")) {
    b.onclick = () => setView(b.dataset.view as View);
  }
  initDivider();

  editor.view.scrollDOM.addEventListener("scroll", () => onScroll("editor", editor.view.scrollDOM), { passive: true });
  preview.pane.addEventListener("scroll", () => onScroll("preview", preview.pane), { passive: true });
  window.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", (e) => {
    if (qf && !(e.target as HTMLElement).closest("#quickfix")) closeQuickFix();
  });

  applySettings(settings);
  harperState = settings.grammar ? "checking" : "off";
  updateHarperStatus();

  // Files dropped on the window open, the first of them.
  await getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "drop" && e.payload.paths.length) void openPath(e.payload.paths[0]);
  });

  await win.onCloseRequested(async (e) => {
    if (!(await confirmDiscard("Close"))) e.preventDefault();
  });

  window.setInterval(() => void checkDisk(), 2000);

  const launch = await api.launch();
  if (launch.view) setView(launch.view, false);
  if (launch.path) await openPath(launch.path);
  else loadDoc(null, "", null);
}

boot().catch((e) => {
  document.body.innerHTML = `<pre class="fatal">mk failed to start:\n${String(e)}</pre>`;
});
