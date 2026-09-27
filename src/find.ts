// Find: one bar for every view (Ctrl+F).
//
// Matches come from the pane you move through. With the editor on screen that
// is the source, and stepping selects each match there (in split, scroll sync
// brings the preview along). With the preview alone it is the rendered text,
// so a search for "foo bar" finds `foo **bar**`, and stepping scrolls the
// preview. Whichever pane is showing gets every match painted.
//
// Highlights are marks, never edits: a CodeMirror decoration in the editor,
// `<mark class="find-hit">` wrappers in the preview, stripped again before
// every search and on close.

import { StateEffect, StateField, type Text as Doc } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { icons } from "./icons";

export interface Match { from: number; to: number }

/** Past this many the count reads "5000+": enough to say there are a lot, few enough to paint. */
export const MAX_MATCHES = 5000;

const escapeRegExp = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/** Every non-overlapping occurrence of `query` in `text`, taken literally. */
export function findAll(text: string, query: string, caseSensitive: boolean, limit = MAX_MATCHES): Match[] {
  if (!query) return [];
  const re = new RegExp(escapeRegExp(query), caseSensitive ? "gu" : "giu");
  const out: Match[] = [];
  for (const m of text.matchAll(re)) {
    out.push({ from: m.index, to: m.index + m[0].length });
    if (out.length >= limit) break;
  }
  return out;
}

/** The first match at or after `pos`, wrapping to the first of all; -1 when there are none. */
export function startIndex(matches: Match[], pos: number): number {
  if (matches.length === 0) return -1;
  const i = matches.findIndex((m) => m.from >= pos);
  return i < 0 ? 0 : i;
}

export interface Span { piece: number; from: number; to: number }

/**
 * Lay pieces of text of `lengths` end to end, and say where each match falls
 * among them: per match, the runs of each piece it covers. How a match in a
 * paragraph's text becomes marks in the text nodes it is made of.
 */
export function spans(lengths: number[], matches: Match[]): Span[][] {
  const starts: number[] = [];
  let at = 0;
  for (const n of lengths) { starts.push(at); at += n; }
  let i = 0;
  return matches.map((m) => {
    while (i < lengths.length && starts[i] + lengths[i] <= m.from) i++;
    const out: Span[] = [];
    for (let j = i; j < lengths.length && starts[j] < m.to; j++) {
      if (lengths[j] === 0) continue;
      out.push({ piece: j, from: Math.max(0, m.from - starts[j]), to: Math.min(lengths[j], m.to - starts[j]) });
    }
    return out;
  });
}

// ---- the editor side ----

const setFind = StateEffect.define<{ matches: Match[]; current: number }>();
const hit = Decoration.mark({ class: "cm-find" });
const hitOn = Decoration.mark({ class: "cm-find cm-find-on" });

/** The editor extension that paints matches. */
export const findHighlight = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setFind)) continue;
      const len = tr.state.doc.length;
      deco = Decoration.set(e.value.matches.flatMap((m, i) =>
        m.to <= len ? [(i === e.value.current ? hitOn : hit).range(m.from, m.to)] : []));
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---- the preview side ----

/** What a match may not run across: the text of one block is searched on its own. */
const BLOCK = "p,li,h1,h2,h3,h4,h5,h6,td,th,pre,blockquote,dt,dd,summary,details,figcaption,caption,div,article,section";

/** Take the marks back out, leaving the text as it was rendered. */
export function clearDom(root: HTMLElement) {
  const marks = root.querySelectorAll("mark.find-hit");
  if (marks.length === 0) return;
  for (const m of marks) m.replaceWith(...m.childNodes);
  root.normalize();
}

/** Mark every match under `root`; per match, the marks it was painted as. */
export function highlightDom(root: HTMLElement, query: string, caseSensitive: boolean): HTMLElement[][] {
  clearDom(root);
  if (!query) return [];
  // Consecutive text nodes of the same block are searched as one string.
  const runs: Text[][] = [];
  let block: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const b = t.parentElement?.closest(BLOCK) ?? root;
    if (b !== block || runs.length === 0) { runs.push([]); block = b; }
    runs[runs.length - 1].push(t);
  }
  const out: HTMLElement[][] = [];
  for (const run of runs) {
    const left = MAX_MATCHES - out.length;
    if (left <= 0) break;
    const matches = findAll(run.map((t) => t.data).join(""), query, caseSensitive, left);
    if (matches.length === 0) continue;
    const perMatch = spans(run.map((t) => t.data.length), matches);
    const marks: HTMLElement[][] = perMatch.map(() => []);
    // Last first: splitting a node leaves its head as the original, so the
    // offsets of every earlier span in it still hold.
    for (let i = perMatch.length - 1; i >= 0; i--) {
      for (let k = perMatch[i].length - 1; k >= 0; k--) {
        const s = perMatch[i][k];
        const node = run[s.piece];
        const mid = s.from > 0 ? node.splitText(s.from) : node;
        if (s.to - s.from < mid.data.length) mid.splitText(s.to - s.from);
        const mark = document.createElement("mark");
        mark.className = "find-hit";
        mid.replaceWith(mark);
        mark.append(mid);
        marks[i].unshift(mark);
      }
    }
    out.push(...marks);
  }
  return out;
}

// ---- the bar ----

export interface FindHooks {
  editor(): EditorView;
  /** The rendered preview, and the pane that scrolls it. */
  preview: HTMLElement;
  pane: HTMLElement;
  /** Whether the preview is on screen at all, and whether it is all that is. */
  previewShown(): boolean;
  previewOnly(): boolean;
}

/** An element's offset in `pane`'s scroll coordinates. */
const topIn = (pane: HTMLElement, el: HTMLElement) =>
  el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;

export class FindBar {
  private input: HTMLInputElement;
  private count: HTMLElement;
  private caseBtn: HTMLButtonElement;
  private query = "";
  private caseSensitive = false;
  /** Matches in the source, and the text they were found in. */
  private matches: Match[] = [];
  private searched: Doc | null = null;
  /** Matches in the preview, as the marks each was painted as: one match may cross several. */
  private hits: HTMLElement[][] = [];
  /** An index into `hits` when the last search was of the preview alone, else into `matches`. */
  private current = -1;
  private inPreview = false;

  constructor(readonly el: HTMLElement, private hooks: FindHooks) {
    el.setAttribute("role", "search");
    this.input = Object.assign(document.createElement("input"), { type: "text", placeholder: "Find", spellcheck: false });
    this.input.setAttribute("aria-label", "Find");
    this.count = Object.assign(document.createElement("span"), { className: "find-count" });
    this.count.setAttribute("aria-live", "polite");
    const button = (tip: string, html: string, run: () => void, cls = "") => {
      const b = document.createElement("button");
      b.className = `icon small ${cls}`.trim();
      b.dataset.tip = tip;
      b.setAttribute("aria-label", tip);
      b.innerHTML = html;
      b.onclick = run;
      return b;
    };
    this.caseBtn = button("Match case", "Aa", () => {
      this.caseSensitive = !this.caseSensitive;
      this.caseBtn.setAttribute("aria-pressed", String(this.caseSensitive));
      this.search(true);
      this.input.focus();
    }, "find-case");
    this.caseBtn.setAttribute("aria-pressed", "false");
    el.append(
      this.input, this.count, this.caseBtn,
      button("Previous match (Shift+Enter)", icons.up, () => this.step(-1)),
      button("Next match (Enter)", icons.down, () => this.step(1)),
      button("Close (Esc)", icons.close, () => this.close()),
    );
    el.hidden = true;
    this.input.addEventListener("input", () => this.search(true));
    this.input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      this.step(e.shiftKey ? -1 : 1);
    });
  }

  get isOpen() { return !this.el.hidden; }

  /** The query as it stands, for handing on to find and replace. */
  get state() { return { query: this.input.value, caseSensitive: this.caseSensitive }; }

  /** Open, or take focus back if already open. A selection on one line becomes the query. */
  open() {
    const seed = this.selectedText();
    const wasOpen = this.isOpen;
    this.el.hidden = false;
    if (seed) this.input.value = seed;
    this.input.focus();
    this.input.select();
    if (!wasOpen || seed) this.search(true);
  }

  close() {
    if (!this.isOpen) return;
    this.el.hidden = true;
    this.matches = [];
    this.hits = [];
    this.current = -1;
    clearDom(this.hooks.preview);
    this.clearEditor();
    // Back to the editor with the last match selected, ready to type over.
    if (!this.hooks.previewOnly()) this.hooks.editor().focus();
  }

  /**
   * After an edit, a render, a new tab or a new view: find again, without
   * moving anything. Closed, it only clears what a stashed tab brought back.
   */
  refresh() {
    if (this.isOpen) this.search(false);
    else this.clearEditor();
  }

  /** The next or previous match, wrapping; opens the bar if it is closed. */
  step(dir: 1 | -1) {
    if (!this.isOpen) { this.open(); return; }
    if (this.input.value !== this.query || this.stale()) this.search(false);
    const n = this.size;
    if (n === 0) return;
    this.current = (this.current + dir + n) % n;
    this.paint();
    this.reveal();
  }

  private get size() { return this.inPreview ? this.hits.length : this.matches.length; }

  /** The source changed, or the preview was drawn again, since the last search. */
  private stale() {
    if (this.hooks.previewOnly() !== this.inPreview) return true;
    if (this.inPreview) return this.hits.length > 0 && !this.hits[0][0].isConnected;
    return this.searched !== this.hooks.editor().state.doc;
  }

  /**
   * Find everything again. The current match becomes the first one from where
   * the reader is: the editor's selection, or the current match (else the top)
   * of the preview. Typing a longer query so stays where it was when it can.
   */
  private search(reveal: boolean) {
    const { pane, preview } = this.hooks;
    const view = this.hooks.editor();
    const previewOnly = this.hooks.previewOnly();
    const was = this.inPreview ? this.hits[this.current]?.[0] : undefined;
    const y = was?.isConnected ? topIn(pane, was) : pane.scrollTop;

    this.inPreview = previewOnly;
    this.query = this.input.value;
    this.searched = view.state.doc;
    this.matches = previewOnly ? [] : findAll(view.state.doc.toString(), this.query, this.caseSensitive);
    if (this.hooks.previewShown()) this.hits = highlightDom(preview, this.query, this.caseSensitive);
    else { clearDom(preview); this.hits = []; }

    if (previewOnly) {
      const i = this.hits.findIndex((marks) => topIn(pane, marks[0]) >= y - 1);
      this.current = this.hits.length === 0 ? -1 : Math.max(0, i);
    } else {
      this.current = startIndex(this.matches, view.state.selection.main.from);
    }
    this.paint();
    if (reveal) this.reveal();
  }

  private paint() {
    const previewOnly = this.hooks.previewOnly();
    const view = this.hooks.editor();
    if (this.matches.length || view.state.field(findHighlight).size) {
      view.dispatch({ effects: setFind.of({ matches: this.matches, current: this.current }) });
    }
    this.hits.forEach((marks, i) => {
      const on = previewOnly && i === this.current;
      for (const m of marks) m.classList.toggle("on", on);
    });
    const n = this.size;
    const total = n >= MAX_MATCHES ? `${MAX_MATCHES}+` : String(n);
    this.count.textContent = !this.query ? "" : n === 0 ? "No results" : `${this.current + 1} of ${total}`;
    this.el.classList.toggle("none", !!this.query && n === 0);
  }

  /** Bring the current match into view: select it in the editor, or scroll the preview to it. */
  private reveal() {
    if (this.current < 0) return;
    if (this.hooks.previewOnly()) {
      const mark = this.hits[this.current][0];
      // A match inside a closed <details> has no place on screen until it opens.
      for (let d = mark.closest("details:not([open])"); d; d = d.parentElement?.closest("details:not([open])") ?? null) {
        (d as HTMLDetailsElement).open = true;
      }
      const pane = this.hooks.pane;
      const top = topIn(pane, mark);
      const margin = 48;
      if (top < pane.scrollTop + margin || top + mark.offsetHeight > pane.scrollTop + pane.clientHeight - margin) {
        pane.scrollTop = Math.max(0, top - pane.clientHeight / 3);
      }
    } else {
      const m = this.matches[this.current];
      this.hooks.editor().dispatch({
        selection: { anchor: m.from, head: m.to },
        effects: EditorView.scrollIntoView(m.from, { y: "nearest", yMargin: 80 }),
      });
    }
  }

  private clearEditor() {
    const view = this.hooks.editor();
    if (view.state.field(findHighlight).size) view.dispatch({ effects: setFind.of({ matches: [], current: -1 }) });
  }

  /** A short selection on one line, from the pane being read, as a query. */
  private selectedText(): string {
    let text = "";
    if (this.hooks.previewOnly()) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && this.hooks.preview.contains(sel.anchorNode)) text = sel.toString();
    } else {
      const { state } = this.hooks.editor();
      const r = state.selection.main;
      text = state.doc.sliceString(r.from, r.to);
    }
    return text && !text.includes("\n") && text.length <= 200 ? text : "";
  }
}
