// Read aloud: what is read, from where, and the player that drives it.
//
// The words come from the rendered preview, not the Markdown, so emphasis
// marks and link targets are never read, a table is read cell by cell with
// its column's header, and a heading is its own sentence. Each sentence keeps
// a DOM Range into the preview, which is how the one being read is
// highlighted (the CSS Custom Highlight API: nothing in the page changes) and
// how Alt+click finds where to start. In the editor-only view the Markdown is
// rendered off screen just to be read, and the editor marks the lines instead.
//
// Typing while listening re-renders the preview under the reader. The voice
// carries on with the sentences it was given; each one is found again in the
// new page by its text as it starts, so the highlight follows the edit.

import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import DOMPurify from "dompurify";
import { api, type Settings, type SpeechInfo } from "./api";
import { icons } from "./icons";
import { render } from "./markdown";
import { autoVoice, PiperEngine, SystemEngine, systemVoices, voiceLabel, type Engine } from "./speech-engine";
import { noRules, parseRules, speakable, type Rules } from "./speech-rules";
import { relocate, sentences } from "./speech-text";
import { baseName } from "./text";

export interface Sentence {
  /** As shown on the page. */
  text: string;
  /** As said. */
  speak: string;
  /** Where it is in the live preview; null when read from an off-screen render. */
  range: Range | null;
  /** The 0-based source line of its block. */
  line: number;
  /** 1–6 for a heading, 0 for anything else. */
  heading: number;
}

/** A sentence never runs across one of these: each is read on its own. */
const BLOCK = "p,li,h1,h2,h3,h4,h5,h6,td,th,pre,blockquote,dt,dd,summary,details,figcaption,caption,div,article,section";
/** Never read. */
const SILENT = "script,style,noscript,svg,math,input,button,select,textarea,thead,pre.front-matter";

export const SPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

// ---------------------------------------------------------------- what to read

/** The Range covering offsets `from`–`to` of `nodes` laid end to end. */
function rangeOf(nodes: Text[], from: number, to: number): Range {
  const r = document.createRange();
  let at = 0;
  let started = false;
  for (const n of nodes) {
    const end = at + n.data.length;
    if (!started && from <= end) { r.setStart(n, from - at); started = true; }
    if (started && to <= end) { r.setEnd(n, to - at); return r; }
    at = end;
  }
  const last = nodes[nodes.length - 1];
  r.setEnd(last, last.data.length);
  return r;
}

const sectionName = (text: string) => text.trim().replace(/[.:]+$/, "").toLowerCase();

/** Every sentence under `root`, in reading order, with the rules applied. */
export function collect(root: HTMLElement, rules: Rules, skipCode: boolean): Sentence[] {
  const runs: { block: Element; nodes: Text[] }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const parent = t.parentElement;
    if (!parent || parent.closest(SILENT) || (skipCode && parent.closest("pre"))) continue;
    const block = parent.closest(BLOCK) ?? root;
    const last = runs[runs.length - 1];
    if (last && last.block === block) last.nodes.push(t);
    else runs.push({ block, nodes: [t] });
  }

  const live = root.isConnected;
  const out: Sentence[] = [];
  let skipping = 0;
  for (const run of runs) {
    const text = run.nodes.map((t) => t.data).join("");
    if (!text.trim()) continue;
    const h = /^H([1-6])$/.exec(run.block.tagName);
    const heading = h ? Number(h[1]) : 0;
    if (heading) {
      if (skipping && heading <= skipping) skipping = 0;
      if (!skipping && rules.skipSections.includes(sectionName(text))) skipping = heading;
    }
    if (skipping) continue;
    if (!heading && rules.skipStarting.some((p) => text.trimStart().startsWith(p))) continue;

    const line = Number(run.block.closest<HTMLElement>("[data-line]")?.dataset.line ?? 0) || 0;
    // A table cell is said with its column's header: "Route: private liquidation".
    let label = "";
    if (run.block instanceof HTMLTableCellElement && run.block.cellIndex > 0) {
      const head = run.block.closest("table")?.tHead?.rows[0]?.cells[run.block.cellIndex];
      label = head ? speakable(head.textContent ?? "", rules) : "";
    }
    let first = true;
    // A heading is one sentence however it is punctuated: "14. Insolvency" is a title, not two sentences.
    const pieces = heading ? [{ from: text.search(/\S/), to: text.trimEnd().length }] : sentences(text, rules.abbreviations);
    for (const piece of pieces) {
      const shown = text.slice(piece.from, piece.to);
      let speak = speakable(shown, rules, heading ? "heading" : "text");
      if (!speak) continue;
      if (label && first) speak = `${label}: ${speak}`;
      first = false;
      out.push({ text: shown, speak, range: live ? rangeOf(run.nodes, piece.from, piece.to) : null, line, heading });
    }
  }
  return out;
}

/** The index of the sentence that ends a reading of the section `from` is in. */
export function sectionEnd(list: Pick<Sentence, "heading">[], from: number): number {
  let level = 0;
  for (let i = Math.min(from, list.length - 1); i >= 0; i--) if (list[i].heading) { level = list[i].heading; break; }
  if (!level) return list.length;
  for (let i = from + 1; i < list.length; i++) if (list[i].heading && list[i].heading <= level) return i;
  return list.length;
}

// ---------------------------------------------------------------- the editor's mark

const setSpeaking = StateEffect.define<{ from: number; to: number } | null>();
const speakingLine = Decoration.line({ class: "cm-speaking" });

/** The editor extension that marks the lines being read. */
export const speakingLines = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setSpeaking)) continue;
      if (!e.value) { deco = Decoration.none; continue; }
      const doc = tr.state.doc;
      const marks = [];
      for (let n = doc.lineAt(e.value.from).number; n <= doc.lineAt(e.value.to).number; n++) {
        marks.push(speakingLine.range(doc.line(n).from));
      }
      deco = Decoration.set(marks);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------- the reader

export interface ReaderHooks {
  settings(): Settings;
  /** Change the speed and keep it for next time. */
  setRate(rate: number): void;
  path(): string | null;
  /** The live preview, when it is on screen. */
  preview(): HTMLElement | null;
  /** The preview's scroller. */
  pane(): HTMLElement;
  /** The document's text, rendered off screen when the preview is hidden. */
  source(): string;
  editor(): EditorView;
  /** Whether the editor is on screen, so it should follow the reading. */
  editorShown(): boolean;
  toast(message: string, ms?: number): void;
  /** Reading started, paused or stopped. */
  changed(): void;
}

type State = "idle" | "playing" | "paused";

export class Reader {
  state: State = "idle";
  private engine: Engine | null = null;
  private engineFor = "";
  private info: SpeechInfo | null = null;
  private rules: Rules = noRules();
  /** The sentences the voice was given. */
  private spoken: Sentence[] = [];
  /** The same text in the page as it is now. */
  private live: Sentence[] = [];
  private index = 0;
  private liveIndex = 0;
  private stopAt = Infinity;
  private scope: "end" | "section" = "end";
  /** The file being read, so its place is saved against it even after a tab switch. */
  private reading: string | null = null;
  /** Documents whose saved place has been offered once already this session. */
  private resumed = new Set<string>();
  private savedAt = 0;
  private waiting = false;
  private warnedFallback = false;
  /** Playing the Settings sample: nothing to highlight, and no place to save. */
  private sampling = false;
  private els!: { play: HTMLButtonElement; status: HTMLElement; speed: HTMLSelectElement; scope: HTMLButtonElement };

  constructor(private bar: HTMLElement, private hooks: ReaderHooks) {
    this.build();
  }

  get active() { return this.state !== "idle"; }

  // ---- transport ----

  async toggle() {
    if (this.state === "playing") this.pause();
    else if (this.state === "paused") this.resume();
    else await this.start();
  }

  /** Begin reading: at `at`, else where the document was left, else where you are looking. */
  async start(at?: number, list?: Sentence[]) {
    this.engine?.stop();
    this.sampling = false;
    this.rules = await this.loadRules();
    if (!(await this.ensureEngine())) return;
    list ??= this.collectNow();
    if (list.length === 0) { this.hooks.toast("Nothing to read here"); return; }
    let from = at ?? (await this.savedPlace(list)) ?? this.here(list);
    from = Math.max(0, Math.min(from, list.length - 1));
    this.spoken = this.live = list;
    this.reading = this.hooks.path();
    this.index = this.liveIndex = from;
    this.stopAt = this.scope === "section" ? sectionEnd(list, from) : Infinity;
    this.state = "playing";
    this.waiting = true;
    this.savedAt = Date.now();
    this.engine!.setRate(this.hooks.settings().speechRate || 1);
    this.engine!.speak(list.map((s) => s.speak), from);
    this.highlight(from);
    this.show();
  }

  /** Alt+click in the preview: read from the sentence under the pointer. */
  async startAtPoint(x: number, y: number) {
    this.rules = await this.loadRules();
    const list = this.collectNow();
    const i = list.findIndex((s) => s.range && [...s.range.getClientRects()].some((r) =>
      x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2));
    if (i >= 0) await this.start(i, list);
  }

  pause() {
    if (this.state !== "playing") return;
    this.engine?.pause();
    this.state = "paused";
    this.save();
    this.paint();
  }

  resume() {
    if (this.state !== "paused") return;
    this.engine?.resume();
    this.state = "playing";
    this.paint();
  }

  stop() {
    if (this.state === "idle") return;
    this.engine?.stop();
    this.save();
    this.end();
  }

  /** One sentence back or on, crossing headings and blocks. */
  async step(by: number) {
    if (this.state === "idle") { await this.start(); return; }
    const to = Math.max(0, Math.min(this.spoken.length - 1, this.index + by));
    this.state = "playing";
    this.waiting = true;
    this.engine!.speak(this.spoken.map((s) => s.speak), to);
    this.highlight(to);
    // Moved now, not when the voice starts, so a second press steps on from here.
    this.index = to;
    this.paint();
  }

  /** The document under the reader changed: find the sentences again in the new page. */
  refresh() {
    if (this.state === "idle") return;
    this.live = this.collectNow();
    this.highlight(this.index);
  }

  /** Settings changed: a new voice takes over at the current sentence; a new speed applies at once. */
  async settingsChanged() {
    const s = this.hooks.settings();
    this.info = null;
    this.engine?.setRate(s.speechRate || 1);
    this.paintSpeed();
    if (this.engine && this.engineFor !== s.speechVoice) {
      const was = this.state;
      this.engine.dispose();
      this.engine = null;
      if (was !== "idle") {
        if (!(await this.ensureEngine())) { this.end(); return; }
        this.engine!.setRate(s.speechRate || 1);
        this.engine!.speak(this.spoken.map((x) => x.speak), this.index);
        if (was === "paused") this.engine!.pause();
      }
    }
  }

  /** Say a line in the chosen voice, for the Settings button. */
  async sample() {
    this.stop();
    if (!(await this.ensureEngine())) return;
    this.sampling = true;
    this.engine!.setRate(this.hooks.settings().speechRate || 1);
    this.engine!.speak([`This is how mk will read your documents, with ${this.engine!.label.replace(/[-_]/g, " ")}.`], 0);
  }

  async speechInfo(): Promise<SpeechInfo> {
    this.info ??= await api.speechInfo().catch(() => ({ piper: null, voices: [] }));
    return this.info;
  }

  // ---- engine events ----

  private started(i: number) {
    if (this.sampling) return;
    if (i >= this.stopAt) { this.engine?.stop(); this.save(); this.end(); return; }
    this.waiting = false;
    this.index = i;
    this.highlight(i);
    if (Date.now() - this.savedAt > 15_000) this.save();
  }

  private finished() {
    if (this.sampling) { this.sampling = false; return; }
    this.save(true);
    this.end();
  }

  private failed(message: string) {
    this.hooks.toast(`Read aloud: ${message}`, 5000);
    if (this.sampling) { this.sampling = false; return; }
    this.save();
    this.end();
  }

  private end() {
    this.state = "idle";
    this.waiting = false;
    if (typeof CSS !== "undefined" && "highlights" in CSS) CSS.highlights.delete("mk-speech");
    this.hooks.editor().dispatch({ effects: setSpeaking.of(null) });
    this.bar.hidden = true;
    this.hooks.changed();
  }

  // ---- where to start ----

  private collectNow(): Sentence[] {
    const skipCode = this.rules.skipCode ?? this.hooks.settings().speechSkipCode;
    const shown = this.hooks.preview();
    if (shown) return collect(shown, this.rules, skipCode);
    const off = document.createElement("article");
    off.innerHTML = DOMPurify.sanitize(render(this.hooks.source()), {
      SANITIZE_NAMED_PROPS: true, ADD_ATTR: ["data-line"], FORBID_TAGS: ["style", "form", "img"],
    });
    return collect(off, this.rules, skipCode);
  }

  /** The first sentence on screen, or the first at the editor's cursor. */
  private here(list: Sentence[]): number {
    if (this.hooks.preview()) {
      const top = this.hooks.pane().getBoundingClientRect().top + 4;
      const i = list.findIndex((s) => s.range && s.range.getBoundingClientRect().bottom > top);
      return Math.max(0, i);
    }
    const v = this.hooks.editor();
    const line = v.state.doc.lineAt(v.state.selection.main.head).number - 1;
    const i = list.findIndex((s) => s.line >= line);
    return i < 0 ? 0 : i;
  }

  /** The place this document was left at, offered once per session. */
  private async savedPlace(list: Sentence[]): Promise<number | null> {
    const path = this.hooks.path();
    if (!path || this.resumed.has(path)) return null;
    this.resumed.add(path);
    const place = await api.placeGet(path).catch(() => null);
    if (!place || place.sentence <= 0) return null;
    const i = relocate(list.map((s) => s.text), place.sentence, place.text);
    if (i > 0) this.hooks.toast("Carrying on where you stopped. Alt+click a sentence to start elsewhere.", 3500);
    return i;
  }

  private save(clear = false) {
    const path = this.reading;
    const s = this.spoken[this.index];
    if (!path || (!s && !clear)) return;
    this.savedAt = Date.now();
    void api.placeSet({ path, sentence: clear ? 0 : this.index, text: clear ? "" : s.text }).catch(() => {});
  }

  // ---- voice and rules ----

  private async loadRules(): Promise<Rules> {
    const path = this.hooks.path();
    if (!path) return noRules();
    const file = await api.speechRules(path).catch(() => null);
    if (!file) return noRules();
    const rules = parseRules(file.text, file.path);
    if (rules.errors.length) {
      const more = rules.errors.length > 1 ? ` (and ${rules.errors.length - 1} more)` : "";
      this.hooks.toast(`${baseName(file.path)}: ${rules.errors[0]}${more}`, 6000);
    }
    return rules;
  }

  private async ensureEngine(): Promise<boolean> {
    const want = this.hooks.settings().speechVoice;
    if (this.engine && this.engineFor === want) return true;
    this.engine?.dispose();
    this.engine = null;
    const events = {
      start: (i: number) => this.started(i),
      done: () => this.finished(),
      error: (m: string) => this.failed(m),
    };
    if (want.startsWith("system:")) {
      this.engine = new SystemEngine(want.slice(7), events);
    } else {
      const info = await this.speechInfo();
      let voice = want ? info.voices.find((v) => v.path === want) ?? null : null;
      if (want && !voice && info.voices.length) this.hooks.toast("The chosen voice is no longer installed; using another.", 4000);
      voice ??= info.piper ? autoVoice(info.voices) : null;
      if (info.piper && voice) {
        this.engine = new PiperEngine(voice, events);
      } else if (typeof speechSynthesis !== "undefined") {
        if (!this.warnedFallback) {
          this.warnedFallback = true;
          this.hooks.toast(info.piper ? "No piper voice found; using the system voice." : "piper is not installed; using the system voice. See Settings, Read aloud.", 5000);
        }
        this.engine = new SystemEngine(null, events);
      } else {
        this.hooks.toast("No voice is available. Install piper and a voice; see Settings, Read aloud.", 6000);
        return false;
      }
    }
    this.engineFor = want;
    return true;
  }

  // ---- showing it ----

  private highlight(i: number) {
    const s = this.spoken[i];
    if (!s) return;
    this.liveIndex = relocate(this.live.map((x) => x.text), Math.min(this.liveIndex + (i - this.index), this.live.length - 1), s.text);
    const at = this.live[this.liveIndex] ?? s;
    if (at.range && typeof CSS !== "undefined" && "highlights" in CSS) {
      CSS.highlights.set("mk-speech", new Highlight(at.range));
      this.keepInView(at.range);
    }
    this.markEditor(at.line);
    this.paint(i);
  }

  /** Scroll the preview only when the sentence is out of view, as a reader's eye would. */
  private keepInView(range: Range) {
    const pane = this.hooks.pane();
    const box = pane.getBoundingClientRect();
    const r = range.getBoundingClientRect();
    if (r.height === 0 && r.width === 0) return;
    const margin = Math.min(120, box.height / 4);
    if (r.top < box.top + margin || r.bottom > box.bottom - margin) {
      pane.scrollTo({ top: pane.scrollTop + r.top - box.top - box.height / 3, behavior: "smooth" });
    }
  }

  /** Mark the source lines of the block being read, up to the next blank line. */
  private markEditor(line: number) {
    const v = this.hooks.editor();
    const doc = v.state.doc;
    if (line + 1 > doc.lines) return;
    const first = doc.line(line + 1);
    let last = first;
    while (last.number < doc.lines && last.number - first.number < 40) {
      const next = doc.line(last.number + 1);
      if (!next.text.trim() || /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~)/.test(next.text)) break;
      last = next;
    }
    const effects: StateEffect<unknown>[] = [setSpeaking.of({ from: first.from, to: last.from })];
    if (this.hooks.editorShown() && !this.hooks.preview()) {
      effects.push(EditorView.scrollIntoView(first.from, { y: "nearest", yMargin: 80 }));
    }
    v.dispatch({ effects });
  }

  // ---- the player bar ----

  private build() {
    const b = this.bar;
    b.setAttribute("role", "toolbar");
    b.setAttribute("aria-label", "Read aloud");
    const button = (icon: string, tip: string, run: () => void) => {
      const el = document.createElement("button");
      el.className = "icon";
      el.innerHTML = icon;
      el.dataset.tip = tip;
      el.setAttribute("aria-label", tip.replace(/ \(.*\)$/, ""));
      el.onclick = run;
      return el;
    };
    const prev = button(icons.prev, "Previous sentence (Alt+[)", () => void this.step(-1));
    const play = button(icons.pause, "Pause (Ctrl+Shift+Space)", () => void this.toggle());
    const next = button(icons.next, "Next sentence (Alt+])", () => void this.step(1));
    const stop = button(icons.stop, "Stop (Esc)", () => this.stop());
    const speed = document.createElement("select");
    speed.className = "rd-speed";
    speed.setAttribute("aria-label", "Speed");
    for (const r of SPEEDS) speed.append(Object.assign(document.createElement("option"), { value: String(r), textContent: `${r}×` }));
    speed.onchange = () => { this.hooks.setRate(Number(speed.value)); this.engine?.setRate(Number(speed.value)); };
    const scope = document.createElement("button");
    scope.className = "rd-scope";
    scope.onclick = () => {
      this.scope = this.scope === "end" ? "section" : "end";
      this.stopAt = this.scope === "section" ? sectionEnd(this.spoken, this.index) : Infinity;
      this.paint();
    };
    const status = Object.assign(document.createElement("span"), { className: "rd-status" });
    status.setAttribute("aria-live", "polite");
    b.append(prev, play, next, stop, Object.assign(document.createElement("span"), { className: "rd-sep" }), speed, scope, status);
    this.els = { play, status, speed, scope };
    this.paintSpeed();
    b.hidden = true;
  }

  private show() {
    this.bar.hidden = false;
    this.paint();
    this.hooks.changed();
  }

  private paintSpeed() {
    const r = this.hooks.settings()?.speechRate || 1;
    const sel = this.els.speed;
    if (![...sel.options].some((o) => Number(o.value) === r)) {
      sel.append(Object.assign(document.createElement("option"), { value: String(r), textContent: `${r}×` }));
    }
    sel.value = String(r);
  }

  private paint(i = this.index) {
    const { play, status, scope } = this.els;
    const playing = this.state === "playing";
    play.innerHTML = playing ? icons.pause : icons.play;
    play.dataset.tip = playing ? "Pause (Ctrl+Shift+Space)" : "Resume (Ctrl+Shift+Space)";
    scope.textContent = this.scope === "end" ? "To the end" : "This section";
    scope.dataset.tip = this.scope === "end" ? "Reading on to the end; click to stop at the end of this section" : "Stopping at the end of this section; click to read on to the end";
    let section = "";
    for (let k = Math.min(i, this.spoken.length - 1); k >= 0; k--) if (this.spoken[k].heading) { section = this.spoken[k].text.replace(/[.:]+$/, ""); break; }
    const where = `${i + 1} / ${this.spoken.length}`;
    status.textContent = this.waiting && playing ? "Preparing the voice…" : this.state === "paused" ? `Paused · ${where}` : section ? `${section} · ${where}` : where;
    status.title = this.engine ? `Voice: ${voiceLabel(this.engine.label)}` : "";
    this.hooks.changed();
  }
}

/** For the Settings dialog: the voices to offer, piper's first. */
export async function voiceChoices(reader: Reader): Promise<{ value: string; label: string }[]> {
  const info = await reader.speechInfo();
  const out = [{ value: "", label: "Automatic" }];
  if (info.piper) for (const v of info.voices) out.push({ value: v.path, label: voiceLabel(v.name) });
  for (const v of systemVoices()) out.push({ value: `system:${v.name}`, label: `System: ${v.name}` });
  return out;
}
