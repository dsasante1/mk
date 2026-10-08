// mk — the app shell.
//
// One document per window. The editor is the source of truth; the preview and
// Harper both read from it after a pause in typing, and neither ever writes
// to it except through an ordinary, undoable CodeMirror transaction (a fix, a
// ticked checkbox).

import "./styles.css";
import { Text, type EditorState } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { nextDiagnostic, previousDiagnostic } from "@codemirror/lint";
import { closeSearchPanel, openSearchPanel, searchPanelOpen, SearchQuery, setSearchQuery } from "@codemirror/search";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { homeDir } from "@tauri-apps/api/path";
import { open as openDialog, save as saveDialog, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import { api, type Issue, type Settings, type View } from "./api";
import { AutoSave, blocked } from "./autosave";
import { Editor } from "./editor";
import { FindBar, findHighlight } from "./find";
import { Grammar, groupOf, GROUP_LABEL, ruleLabel, type Group } from "./grammar";
import { headings } from "./markdown";
import { Preview } from "./preview";
import { Reader, speakingLines, voiceChoices } from "./reader";
import { SectionNav } from "./section-nav";
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

/**
 * One open document. The editor, preview and Harper are shared and show the
 * current tab, `doc`; every other tab keeps its whole editor state (undo
 * history, selection) and its place, ready to be put back.
 */
interface Tab {
  path: string | null;
  eol: Eol;
  saved: Text;
  mtime: number | null;
  /** Set while our own save is in flight, so the watcher does not see it as someone else's. */
  writing: boolean;
  /** The last write queued. Writes to one file go one at a time: they share a temporary file. */
  queue: Promise<unknown>;
  /** The editor state while another tab has the editor; null while this one does. */
  state: EditorState | null;
  scroll: ReturnType<EditorView["scrollSnapshot"]> | null;
  previewTop: number;
}

const newTab = (): Tab =>
  ({ path: null, eol: "\n", saved: Text.empty, mtime: null, writing: false, queue: Promise.resolve(), state: null, scroll: null, previewTop: 0 });

let doc = newTab();
const tabs: Tab[] = [doc];

const textOf = (t: Tab) => (t === doc ? editor.doc : t.state?.doc ?? Text.empty);
const isDirty = (t: Tab) => !textOf(t).eq(t.saved);
const dirty = () => isDirty(doc);
/** An untitled, empty, untouched tab: what opening a file may take over. */
const pristine = (t: Tab) => !t.path && textOf(t).length === 0 && !isDirty(t);

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

const speechKey = (s: Settings | undefined) => s ? `${s.speechVoice}|${s.speechRate}|${s.speechPiper}` : "";

function applySettings(next: Settings) {
  const grammarWas = settings?.grammar;
  const autoSaveWas = settings?.autoSave;
  const speechWas = speechKey(settings);
  settings = next;
  applyTheme();
  editor?.apply(settings);
  setView(settings.view, false);
  setProblems(settings.problemsOpen, false);
  if (grammar && grammarWas !== settings.grammar) grammar.setEnabled(settings.grammar);
  sectionNav.setEnabled(settings.sectionNav);
  // Switched on with edits outstanding: those are saved too, not only the next.
  if (settings.autoSave && autoSaveWas === false) for (const t of tabs) autoSave.schedule(t);
  if (reader && speechWas && speechWas !== speechKey(settings)) void reader.settingsChanged();
  updateStatus();
}

// ---------------------------------------------------------------- editor + preview + grammar

let editor: Editor;
let grammar: Grammar;
let reader: Reader;
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

// ---------------------------------------------------------------- section rail
//
// It sits on the pane being read: the preview whenever it is showing, the
// editor otherwise. Jumps land a little below the pane's top, as a heading
// link in the preview does.

const reading = () => settings.view === "edit" ? editor.view.scrollDOM : preview.pane;

const sectionNav = new SectionNav($("section-nav"), {
  scroller: reading,
  lineAt: (offset) => settings.view === "edit" ? editor.topLine(offset) : preview.topLine(offset),
  jump(line) {
    if (settings.view === "edit") editor.scrollToLine(line, 16);
    else {
      holdJump();
      preview.pane.scrollTo({ top: Math.max(0, preview.heightOfLine(line) - 16), behavior: "smooth" });
    }
  },
});

// ---------------------------------------------------------------- find

const findBar = new FindBar($("find"), {
  editor: () => editor.view,
  preview: preview.el,
  pane: preview.pane,
  previewShown: () => settings.view !== "edit",
  previewOnly: () => settings.view === "preview",
});

/** CodeMirror's own panel, for replacing: it starts from whatever the find bar held. */
function openReplace() {
  const { query, caseSensitive } = findBar.state;
  findBar.close();
  ensureEditor();
  openSearchPanel(editor.view);
  if (query) editor.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: query, caseSensitive, literal: true })) });
}

/** After an edit, a new document or a new view: preview first, so its layout is current. */
function refresh() {
  renderPreview();
  sectionNav.set(headings(editor.text()));
  findBar.refresh();
  reader.refresh();
}

function onUpdate(u: ViewUpdate) {
  if (u.docChanged) {
    grammar.changed(u.changes);
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(refresh, 120);
    updateTitle();
    autoSave.schedule(doc);
  }
  if (u.docChanged || u.selectionSet) updateStatus();
}

// ---------------------------------------------------------------- scroll sync
//
// Each pane remembers the scrollTop we last set on it. A scroll event that
// lands there is our own echo and is ignored; anything else is the user, and
// drives the other pane. Without this the two panes chase each other.
//
// A jump from the section rail is a smooth scroll of the preview, and any
// write to the preview's scrollTop cancels one. The editor's answer to being
// synced is often a small scroll of its own (CodeMirror correcting a height it
// had estimated), so while a jump is moving the editor follows but does not
// steer.

const expected = { editor: -1, preview: -1 };
let jumping: number | undefined;

/** Hold the editor to following until the preview has been still for a moment. */
function holdJump() {
  window.clearTimeout(jumping);
  jumping = window.setTimeout(() => { jumping = undefined; }, 200);
}

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
  sectionNav.schedule();
  if (jumping !== undefined) {
    if (source === "editor") return;
    holdJump();
  }
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
  if (editor) findBar.refresh();
  reader?.refresh();
  sectionNav.schedule();
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

// ---------------------------------------------------------------- recent files
//
// A dropdown of the files opened lately, newest first. The list lives on the
// Rust side so it survives restarts and is shared between windows; it is read
// fresh each time the menu opens so a file opened in another window is there.

let recentMenu: { items: string[]; index: number } | null = null;

/** Note a file as opened, so it heads the recent list. Failures are silent: a menu is not worth a toast. */
function rememberRecent(path: string) {
  api.recentAdd(path).catch(() => {});
}

async function openRecent() {
  if (recentMenu) { closeRecent(); return; }
  const items = await api.recentGet().catch(() => [] as string[]);
  const menu = $("recent");
  menu.replaceChildren();
  menu.append(Object.assign(document.createElement("div"), { className: "rc-head", textContent: "Recent files" }));

  if (items.length === 0) {
    menu.append(Object.assign(document.createElement("div"), { className: "rc-empty", textContent: "No files opened yet." }));
  } else {
    items.forEach((path, n) => {
      const b = document.createElement("button");
      b.className = "rc-item";
      b.setAttribute("role", "menuitem");
      b.title = tildify(path, home);
      b.append(
        Object.assign(document.createElement("span"), { className: "rc-name", textContent: baseName(path) }),
        Object.assign(document.createElement("span"), { className: "rc-dir", textContent: tildify(dirName(path), home) }),
      );
      b.onmouseenter = () => { if (recentMenu) { recentMenu.index = n; paintRecent(); } };
      b.onclick = () => { closeRecent(); void openPath(path); };
      menu.append(b);
    });
    const foot = document.createElement("div");
    foot.className = "rc-foot";
    const clear = document.createElement("button");
    clear.textContent = "Clear recent files";
    clear.onclick = () => { closeRecent(); void api.recentClear().catch((e) => toast(String(e))); };
    foot.append(clear);
    menu.append(foot);
  }

  recentMenu = { items, index: 0 };
  menu.hidden = false;
  const anchor = $("btn-recent").getBoundingClientRect();
  const x = Math.min(anchor.left, window.innerWidth - menu.offsetWidth - 12);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${anchor.bottom + 6}px`;
  $("btn-recent").setAttribute("aria-expanded", "true");
  paintRecent();
}

function paintRecent() {
  $("recent").querySelectorAll(".rc-item").forEach((el, n) => el.classList.toggle("sel", n === recentMenu?.index));
}

function closeRecent() {
  recentMenu = null;
  $("recent").hidden = true;
  $("btn-recent").setAttribute("aria-expanded", "false");
}

function recentKey(e: KeyboardEvent): boolean {
  if (!recentMenu) return false;
  const n = recentMenu.items.length;
  if (e.key === "Escape") { closeRecent(); $("btn-recent").focus(); return true; }
  if (n === 0) return false;
  if (e.key === "ArrowDown") { recentMenu.index = (recentMenu.index + 1) % n; paintRecent(); return true; }
  if (e.key === "ArrowUp") { recentMenu.index = (recentMenu.index - 1 + n) % n; paintRecent(); return true; }
  if (e.key === "Enter") { const path = recentMenu.items[recentMenu.index]; closeRecent(); void openPath(path); return true; }
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
  renderTabs();
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

// ---------------------------------------------------------------- tabs

const tabName = (t: Tab) => (t.path ? baseName(t.path) : "Untitled");

function renderTabs() {
  const bar = $("tabs");
  bar.replaceChildren(...tabs.map((t) => {
    const el = document.createElement("div");
    el.className = `tab${t === doc ? " on" : ""}${isDirty(t) ? " dirty" : ""}`;
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", String(t === doc));
    el.title = t.path ? tildify(t.path, home) : "Untitled";
    const name = Object.assign(document.createElement("span"), { className: "tab-name", textContent: tabName(t) });
    const x = document.createElement("button");
    x.className = "tab-x";
    x.innerHTML = icons.close;
    x.setAttribute("aria-label", `Close ${tabName(t)}`);
    x.onclick = (e) => { e.stopPropagation(); void closeTab(t); };
    el.append(name, x);
    el.onclick = () => activate(t);
    // Middle-click closes, as in a browser.
    el.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); void closeTab(t); } };
    return el;
  }));
  const on = bar.querySelector<HTMLElement>(".tab.on");
  if (on) {
    if (on.offsetLeft < bar.scrollLeft) bar.scrollLeft = on.offsetLeft;
    else if (on.offsetLeft + on.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = on.offsetLeft + on.offsetWidth - bar.clientWidth;
  }
}

/** Put the current tab's editor state and place aside. */
function stash() {
  doc.state = editor.view.state;
  doc.scroll = editor.view.scrollSnapshot();
  doc.previewTop = preview.pane.scrollTop;
}

/** Show `doc` in the shared editor, preview and Harper. */
function showDoc() {
  // Reading belongs to a document; another one in the window ends it.
  reader?.stop();
  preview.setDir(doc.path ? dirName(doc.path) : null);
  hideBanner();
  updateTitle();
  updateStatus();
  void grammar.reset(doc.path);
  window.clearTimeout(previewTimer);
  if (settings.view !== "edit") preview.render(editor.text());
  sectionNav.set(headings(editor.text()));
  findBar.refresh();
  editor.view.focus();
}

/** Make `t` current, without stashing whatever was: it may be gone. */
function enter(t: Tab) {
  doc = t;
  if (t.state) editor.restore(t.state);
  else editor.load("");
  const scroll = t.scroll;
  t.state = null;
  t.scroll = null;
  showDoc();
  if (scroll) editor.view.dispatch({ effects: scroll });
  expected.preview = t.previewTop;
  preview.pane.scrollTop = t.previewTop;
  void checkDisk();
}

function activate(t: Tab) {
  if (t === doc || !tabs.includes(t)) return;
  const left = doc;
  stash();
  enter(t);
  void autoSave.flush(left);
}

function cycleTab(step: number) {
  const i = tabs.indexOf(doc);
  activate(tabs[(i + step + tabs.length) % tabs.length]);
}

/** A new tab after the current one, holding `text`, made current. */
function addTab(text: string): Tab {
  stash();
  const t = newTab();
  tabs.splice(tabs.indexOf(doc) + 1, 0, t);
  doc = t;
  editor.load(text);
  return t;
}

async function closeTab(t: Tab) {
  if (!tabs.includes(t)) return;
  await autoSave.flush(t);
  if (!tabs.includes(t)) return;
  if (isDirty(t)) {
    activate(t);
    if (!(await confirmDiscard("Close"))) return;
  }
  const i = tabs.indexOf(t);
  if (i < 0) return;
  tabs.splice(i, 1);
  autoSave.cancel(t);
  if (t !== doc) { renderTabs(); return; }
  // The last tab closed leaves an empty one, not an empty window.
  if (tabs.length === 0) tabs.push(newTab());
  enter(tabs[Math.min(i, tabs.length - 1)]);
}

/** Open text as a document: in the current tab if that is still blank, else in a new one. */
function openDoc(path: string | null, content: string, mtime: number | null) {
  const text = content.replace(/\r\n?/g, "\n");
  if (pristine(doc)) editor.load(text);
  else addTab(text);
  doc.path = path;
  doc.eol = detectEol(content);
  doc.mtime = mtime;
  doc.saved = editor.doc;
  preview.pane.scrollTop = 0;
  showDoc();
}

async function openPath(path: string) {
  const open = tabs.find((t) => t.path === path);
  if (open) { activate(open); return; }
  try {
    const d = await api.readFile(path);
    // The same file by another name, a symlink say, is still the one tab.
    const same = tabs.find((t) => t.path === d.path);
    if (same) { activate(same); return; }
    openDoc(d.path, d.content, d.mtime);
    rememberRecent(d.path);
  } catch (e) {
    const msg = String(e);
    // A path that does not exist yet is a new document to be saved there.
    if (/No such file|not found|os error 2/i.test(msg)) {
      openDoc(path, "", null);
      toast(`New file — it will be created at ${tildify(path, home)} on save`);
    } else {
      await message(msg, { title: "Could not open", kind: "error" });
    }
  }
}

async function openPaths(paths: string[]) {
  for (const p of paths) await openPath(p);
}

async function openWithDialog() {
  const picked = await openDialog({ multiple: true, directory: false, filters: MD_FILTERS, defaultPath: doc.path ? dirName(doc.path) : undefined });
  if (picked) await openPaths(Array.isArray(picked) ? picked : [picked]);
}

const UNTITLED_HINT = "This Untitled tab is already a new file. Start typing, then press Ctrl+S to save it.";

/** New on an empty Untitled tab reuses it, so say so rather than seem to do nothing. */
function pointAtUntitled() {
  const on = $("tabs").querySelector<HTMLElement>(".tab.on");
  if (on) { on.classList.remove("flash"); void on.offsetWidth; on.classList.add("flash"); }
  const showing = [...$("toasts").children].some((el) => el.textContent === UNTITLED_HINT && !el.classList.contains("out"));
  if (!showing) toast(UNTITLED_HINT, 4000);
}

function newDoc() {
  if (pristine(doc)) { pointAtUntitled(); editor.view.focus(); return; }
  addTab("");
  preview.pane.scrollTop = 0;
  showDoc();
}

async function save(): Promise<boolean> {
  if (!doc.path) return saveAs();
  return writeTo(doc, doc.path);
}

async function saveAs(): Promise<boolean> {
  // The tab, not `doc`: the user may switch tabs while the dialog or write is out.
  const t = doc;
  const picked = await saveDialog({
    filters: MD_FILTERS,
    defaultPath: t.path ?? (home ? `${home}/Untitled.md` : "Untitled.md"),
  });
  if (!picked) return false;
  const path = /\.[^/\\]+$/.test(baseName(picked)) ? picked : `${picked}.md`;
  const was = t.path;
  const ok = await writeTo(t, path);
  if (ok && path !== was) rememberRecent(path);
  // A tab in the background picks its new folder up when it is shown.
  if (ok && path !== was && t === doc) {
    preview.setDir(dirName(path));
    void grammar.reset(path);
    renderPreview();
    findBar.refresh();
    updateTitle();
  }
  return ok;
}

async function writeTo(t: Tab, path: string): Promise<boolean> {
  try {
    await queued(t, () => writeNow(t, path));
    toast(`Saved ${baseName(path)}`, 1400);
    return true;
  } catch (e) {
    await message(String(e), { title: "Could not save", kind: "error" });
    return false;
  }
}

/** Run `job` after any write of `t` already out. Writes of one file go one at a time: they share a temporary file. */
function queued(t: Tab, job: () => Promise<void>): Promise<void> {
  const run = t.queue.then(job);
  t.queue = run.catch(() => {});
  return run;
}

/** Write `t` to `path` and mark it saved. Only from inside `queued`. */
async function writeNow(t: Tab, path: string) {
  // Taken now, not when queued, so the newest text is what lands.
  const snapshot = textOf(t);
  t.writing = true;
  try {
    t.mtime = await api.writeFile(path, withEol(snapshot.toString(), t.eol));
    t.path = path;
    t.saved = snapshot;
    updateTitle();
  } finally {
    t.writing = false;
  }
}

// ---------------------------------------------------------------- auto save
//
// Quiet on success: the unsaved dot going away is the whole signal. A failure
// or a file changed underneath says so once, then waits for the next edit,
// rather than a dialog every second while you type.

type AutoSaveTrouble = "changed" | "failed";
const autoSaveWarned = new WeakMap<Tab, AutoSaveTrouble>();
let closing = false;

function autoSaveWarn(t: Tab, trouble: AutoSaveTrouble, msg: string) {
  // While the window closes, the prompt for each unsaved tab says it all.
  if (closing || autoSaveWarned.get(t) === trouble) return;
  autoSaveWarned.set(t, trouble);
  toast(msg, 5000);
}

/**
 * Queued like any write, so the disk is checked just before this write and
 * not before whatever was ahead of it, and a Ctrl+S or Save As ahead of it
 * is seen for what it did.
 */
function autoWrite(t: Tab): Promise<void> {
  return queued(t, async () => {
    const path = t.path;
    if (!path || !tabs.includes(t) || !isDirty(t)) return;
    const disk = await api.fileMtime(path).catch(() => null);
    if (t.path !== path || !tabs.includes(t)) return;
    const why = blocked(t, isDirty(t), disk);
    if (why === "changed") {
      // The current tab's banner asks about this, except for a file that did
      // not exist when opened: the watcher has no time to compare it with.
      if (t !== doc || t.mtime === null) autoSaveWarn(t, "changed", `${tabName(t)} changed on disk; auto save is paused for it`);
      return;
    }
    if (why) return;
    try {
      await writeNow(t, path);
      autoSaveWarned.delete(t);
    } catch (e) {
      autoSaveWarn(t, "failed", `Auto save failed: ${e}`);
    }
  });
}

const autoSave = new AutoSave<Tab>({
  enabled: () => settings.autoSave,
  write: autoWrite,
});

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
  const t = doc;
  if (!t.path) return;
  try {
    const d = await api.readFile(t.path);
    if (t !== doc) return;
    doc.eol = detectEol(d.content);
    editor.replaceKeepingPlace(d.content.replace(/\r\n?/g, "\n"));
    doc.saved = editor.doc;
    doc.mtime = d.mtime;
    autoSaveWarned.delete(doc);
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
  const t = doc;
  if (!t.path || t.writing || t.mtime === null || !$("banner").hidden) return;
  const m = await api.fileMtime(t.path).catch(() => null);
  if (t !== doc || m === null || m === t.mtime || t.writing) return;
  if (!dirty()) { await reloadFromDisk(true); return; }
  const seen = m;
  showBanner(`${baseName(t.path)} changed on disk.`, [
    ["Reload (lose my edits)", () => void reloadFromDisk(false)],
    ["Keep mine", () => { t.mtime = seen; autoSaveWarned.delete(t); autoSave.schedule(t); }],
  ]);
}

// ---------------------------------------------------------------- keys

function onKey(e: KeyboardEvent) {
  if (quickFixKey(e)) { e.preventDefault(); return; }
  if (recentKey(e)) { e.preventDefault(); return; }
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const stop = () => { e.preventDefault(); e.stopPropagation(); };

  if (e.key === "Escape") {
    // Esc closes the innermost open thing and is otherwise nothing. It is
    // never how you quit, and never how you lose work.
    if (settingsDialog.open) return;
    if (findBar.isOpen) { findBar.close(); stop(); return; }
    if (!$("banner").hidden) { hideBanner(); stop(); return; }
    if (reader.active) { reader.stop(); stop(); }
    return;
  }
  // Read aloud. Space alone is for typing, and [ ] are characters, so the
  // keys carry modifiers; the sentence keys only act while reading.
  if (mod && e.shiftKey && e.code === "Space") { stop(); void reader.toggle(); return; }
  if (e.altKey && !mod && reader.active && (e.code === "BracketLeft" || e.code === "BracketRight")) {
    stop(); void reader.step(e.code === "BracketLeft" ? -1 : 1); return;
  }
  if (mod && !e.shiftKey && k === "s") { stop(); void save(); return; }
  if (mod && e.shiftKey && k === "s") { stop(); void saveAs(); return; }
  if (mod && !e.shiftKey && k === "o") { stop(); void openWithDialog(); return; }
  if (mod && e.shiftKey && k === "o") { stop(); void openRecent(); return; }
  if (mod && !e.shiftKey && k === "n") { stop(); newDoc(); return; }
  if (mod && !e.shiftKey && k === "w") { stop(); void closeTab(doc); return; }
  if (mod && e.key === "Tab") { stop(); cycleTab(e.shiftKey ? -1 : 1); return; }
  if (mod && e.key === "PageDown") { stop(); cycleTab(1); return; }
  if (mod && e.key === "PageUp") { stop(); cycleTab(-1); return; }
  if (mod && !e.shiftKey && k === "f") { stop(); closeSearchPanel(editor.view); findBar.open(); return; }
  if (mod && e.shiftKey && k === "f") { stop(); openReplace(); return; }
  // F3 and Ctrl+G step through the bar's matches, unless replace has them.
  if (e.key === "F3" || (mod && !e.altKey && k === "g")) {
    if (!findBar.isOpen && searchPanelOpen(editor.view.state)) return;
    stop(); findBar.step(e.shiftKey ? -1 : 1); return;
  }
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

  editor = new Editor($("editor-pane"), settings, [findHighlight, speakingLines], {
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

  reader = new Reader($("reader"), {
    settings: () => settings,
    setRate(rate) { settings.speechRate = rate; saveSettingsSoon(); },
    path: () => doc.path,
    preview: () => (settings.view !== "edit" ? preview.el : null),
    pane: () => preview.pane,
    source: () => editor.text(),
    editor: () => editor.view,
    editorShown: () => settings.view !== "preview",
    toast,
    changed() {
      const b = $("btn-read");
      b.classList.toggle("on", reader.active);
      b.dataset.tip = reader.state === "playing" ? "Pause reading (Ctrl+Shift+Space)" : reader.state === "paused" ? "Resume reading (Ctrl+Shift+Space)" : "Read aloud (Ctrl+Shift+Space)";
    },
  });

  settingsDialog = new SettingsDialog($("settings") as HTMLDialogElement, {
    current: () => settings,
    onChange(s) {
      applySettings(s);
      saveSettings();
    },
    relint() { void savingSettings.then(() => grammar.schedule(0)); },
    ignoredCount: () => grammar.ignoredCount,
    clearIgnored: () => void grammar.clearIgnored(),
    speech: {
      choices: () => voiceChoices(reader),
      info: () => reader.speechInfo(),
      sample: () => void reader.sample(),
    },
  });

  // chrome
  $("btn-new").innerHTML = icons.newFile;
  $("btn-open").innerHTML = icons.open;
  $("btn-recent").innerHTML = icons.recent;
  $("btn-save").innerHTML = icons.save;
  $("btn-find").innerHTML = icons.search;
  $("btn-read").innerHTML = icons.speaker;
  $("btn-settings").innerHTML = icons.settings;
  $("btn-problems-close").innerHTML = icons.close;
  $("btn-new").onclick = newDoc;
  $("btn-open").onclick = () => void openWithDialog();
  $("btn-recent").onclick = () => void openRecent();
  $("btn-save").onclick = () => void save();
  $("btn-settings").onclick = () => void settingsDialog.show();
  $("btn-theme").onclick = toggleTheme;
  $("btn-find").onclick = () => {
    if (findBar.isOpen) findBar.close();
    else { closeSearchPanel(editor.view); findBar.open(); }
  };
  $("btn-read").onclick = () => void reader.toggle();
  // Alt+click a sentence in the preview to read from there. Caught on the way
  // down, so an Alt+click on a link reads it instead of following it.
  preview.el.addEventListener("click", (e) => {
    if (!e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    void reader.startAtPoint(e.clientX, e.clientY);
  }, true);
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
  window.addEventListener("resize", () => sectionNav.schedule());
  window.addEventListener("blur", () => void autoSave.flushAll());
  document.addEventListener("mousedown", (e) => {
    if (qf && !(e.target as HTMLElement).closest("#quickfix")) closeQuickFix();
    const t = e.target as HTMLElement;
    if (recentMenu && !t.closest("#recent") && !t.closest("#btn-recent")) closeRecent();
  });

  applySettings(settings);
  harperState = settings.grammar ? "checking" : "off";
  updateHarperStatus();

  // Files dropped on the window open, each in its own tab.
  await getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "drop") void openPaths(e.payload.paths);
  });

  // Every tab with unsaved work is asked about, in turn; one Cancel keeps the window.
  await win.onCloseRequested(async (e) => {
    reader.stop();
    closing = true;
    try {
      await Promise.all(tabs.map((t) => autoSave.flush(t)));
      for (const t of [...tabs]) {
        if (!isDirty(t)) continue;
        activate(t);
        if (!(await confirmDiscard("Close"))) { e.preventDefault(); return; }
      }
    } finally {
      closing = false;
    }
  });

  window.setInterval(() => void checkDisk(), 2000);

  const launch = await api.launch();
  if (launch.view) setView(launch.view, false);
  if (launch.paths.length) await openPaths(launch.paths);
  else showDoc();
}

boot().catch((e) => {
  document.body.innerHTML = `<pre class="fatal">mk failed to start:\n${String(e)}</pre>`;
});
