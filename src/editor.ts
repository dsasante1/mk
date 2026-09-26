// The CodeMirror editor, set up for prose rather than code.
//
// Browser spellcheck is off because Harper is the spellchecker: two sets of
// squiggles that disagree about the same word is worse than either. Settings
// live in a compartment so a font change is a reconfigure, not a new state —
// a new state would throw the undo history away with it.

import { EditorState, Compartment, EditorSelection, type Extension, type TransactionSpec, type Text } from "@codemirror/state";
import {
  EditorView, keymap, drawSelection, dropCursor, highlightActiveLine, highlightSpecialChars,
  rectangularSelection, crosshairCursor, lineNumbers, placeholder, type ViewUpdate, type Command,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { tags as t } from "@lezer/highlight";
import type { Settings } from "./api";

const chrome = EditorView.theme({
  "&": { color: "var(--fg)", backgroundColor: "var(--bg)", height: "100%" },
  ".cm-scroller": { lineHeight: "1.65" },
  ".cm-content": { caretColor: "var(--accent)", padding: "28px 0 40vh" },
  ".cm-line": { padding: "0 32px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--selection)" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--faint)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 4px 0 16px", minWidth: "40px" },
  ".cm-selectionMatch": { backgroundColor: "var(--match)" },
  ".cm-searchMatch": { backgroundColor: "var(--match)", outline: "1px solid var(--border-strong)" },
  ".cm-placeholder": { color: "var(--faint)" },
  ".cm-panels": { backgroundColor: "var(--bg-raised)", color: "var(--fg)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-tooltip": { backgroundColor: "var(--bg-raised)", border: "1px solid var(--border)", color: "var(--fg)", borderRadius: "8px" },
});

/** Markdown that looks like what it will become, without hiding the marks. */
const prose = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700", fontSize: "1.45em", color: "var(--heading)" },
  { tag: t.heading2, fontWeight: "700", fontSize: "1.25em", color: "var(--heading)" },
  { tag: t.heading3, fontWeight: "700", fontSize: "1.1em", color: "var(--heading)" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "700", color: "var(--heading)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--link)" },
  { tag: t.url, color: "var(--faint)" },
  { tag: t.monospace, fontFamily: "var(--mono)", color: "var(--code)" },
  { tag: t.quote, color: "var(--muted)", fontStyle: "italic" },
  { tag: t.processingInstruction, color: "var(--faint)" },
  { tag: t.contentSeparator, color: "var(--faint)" },
  { tag: [t.meta, t.comment], color: "var(--faint)" },
  // Fenced code, highlighted by the language it names.
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.atom], color: "var(--syn-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-function)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-property)" },
  { tag: t.lineComment, color: "var(--faint)", fontStyle: "italic" },
  { tag: t.blockComment, color: "var(--faint)", fontStyle: "italic" },
]);

// ---- Markdown formatting, as pure state → transaction functions ----

/**
 * Wrap each selection in `mark`, or unwrap it if it is already wrapped —
 * checked both inside the selection and just outside it, since selecting a
 * bold word by double-click leaves the stars outside. An empty selection
 * gets a pair with the cursor between.
 */
export function toggleWrap(state: EditorState, mark: string): TransactionSpec {
  const n = mark.length;
  return state.changeByRange((range) => {
    const doc = state.doc;
    const text = doc.sliceString(range.from, range.to);
    if (text.length >= 2 * n && text.startsWith(mark) && text.endsWith(mark)) {
      return {
        changes: [{ from: range.from, to: range.from + n }, { from: range.to - n, to: range.to }],
        range: EditorSelection.range(range.from, range.to - 2 * n),
      };
    }
    const before = doc.sliceString(Math.max(0, range.from - n), range.from);
    const after = doc.sliceString(range.to, Math.min(doc.length, range.to + n));
    if (!range.empty && before === mark && after === mark) {
      return {
        changes: [{ from: range.from - n, to: range.from }, { from: range.to, to: range.to + n }],
        range: EditorSelection.range(range.from - n, range.to - n),
      };
    }
    return {
      changes: [{ from: range.from, insert: mark }, { from: range.to, insert: mark }],
      range: EditorSelection.range(range.from + n, range.to + n),
    };
  });
}

/** `[selection](url)` with `url` selected, ready to be typed over. */
export function insertLink(state: EditorState): TransactionSpec {
  return state.changeByRange((range) => {
    const label = state.doc.sliceString(range.from, range.to);
    const isUrl = /^https?:\/\/\S+$/.test(label);
    const insert = isUrl ? `[](${label})` : `[${label}](url)`;
    const start = isUrl ? range.from + 1 : range.from + label.length + 3;
    const end = isUrl ? start : start + 3;
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.range(start, end) };
  });
}

/** Cycle the current line through `#` … `######` and back to plain. */
export function cycleHeading(state: EditorState): TransactionSpec {
  const line = state.doc.lineAt(state.selection.main.head);
  const m = /^(#{1,6})\s+/.exec(line.text);
  const level = m ? m[1].length : 0;
  const next = level >= 6 ? "" : "#".repeat(level + 1) + " ";
  return { changes: { from: line.from, to: line.from + (m ? m[0].length : 0), insert: next } };
}

const run = (f: (s: EditorState) => TransactionSpec): Command => (view) => {
  view.dispatch(view.state.update(f(view.state), { scrollIntoView: true, userEvent: "input" }));
  return true;
};

export interface EditorHooks {
  onUpdate(u: ViewUpdate): void;
  keys: { key: string; run: Command; shift?: Command; preventDefault?: boolean }[];
}

function settingsExt(s: Settings): Extension[] {
  const font = s.editorFont.trim() || "var(--editor-font)";
  return [
    ...(s.lineNumbers ? [lineNumbers()] : []),
    ...(s.wrap ? [EditorView.lineWrapping] : []),
    EditorView.theme({
      "&": { fontSize: `${s.fontSize}px` },
      ".cm-content": { fontFamily: font },
      ".cm-gutters": { fontFamily: "var(--mono)", fontSize: "0.8em" },
    }),
  ];
}

export class Editor {
  readonly view: EditorView;
  private settingsComp = new Compartment();
  private extra: Extension[];

  constructor(parent: HTMLElement, settings: Settings, extra: Extension[], private hooks: EditorHooks) {
    this.extra = extra;
    this.view = new EditorView({ parent, state: this.state("", settings) });
  }

  private settings: Settings | null = null;

  private state(doc: string, s: Settings): EditorState {
    this.settings = s;
    return EditorState.create({
      doc,
      extensions: [
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        // Front matter is YAML, not a setext heading — which is what plain
        // Markdown makes of `title: x` followed by `---`.
        yamlFrontmatter({ content: markdown({ base: markdownLanguage, codeLanguages: languages }) }),
        syntaxHighlighting(prose),
        placeholder("Start writing…"),
        EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
        this.settingsComp.of(settingsExt(s)),
        ...this.extra,
        keymap.of([
          ...this.hooks.keys,
          { key: "Mod-b", run: run((s) => toggleWrap(s, "**")) },
          { key: "Mod-i", run: run((s) => toggleWrap(s, "*")) },
          { key: "Mod-`", run: run((s) => toggleWrap(s, "`")) },
          { key: "Mod-Shift-x", run: run((s) => toggleWrap(s, "~~")) },
          { key: "Mod-k", run: run(insertLink) },
          { key: "Mod-h", run: run(cycleHeading) },
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        chrome,
        EditorView.updateListener.of((u) => this.hooks.onUpdate(u)),
      ],
    });
  }

  /** A new document is a new state, so undo cannot walk into the last file. */
  load(text: string) {
    this.view.setState(this.state(text, this.settings!));
  }

  /**
   * Replace the text but keep the place: used when the file changed on disk
   * under a clean buffer. One change, so it is also one undo step.
   */
  replaceKeepingPlace(text: string) {
    const v = this.view;
    const top = v.scrollDOM.scrollTop;
    const head = Math.min(v.state.selection.main.head, text.length);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: head } });
    v.scrollDOM.scrollTop = top;
  }

  get doc(): Text { return this.view.state.doc; }
  text(): string { return this.view.state.doc.toString(); }

  apply(s: Settings) {
    this.settings = s;
    this.view.dispatch({ effects: this.settingsComp.reconfigure(settingsExt(s)) });
  }

  select(from: number, to: number) {
    this.view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    this.view.focus();
  }

  // ---- scroll position as a fractional, 0-based source line ----

  topLine(): number {
    const v = this.view;
    const top = v.scrollDOM.scrollTop - v.documentPadding.top;
    const block = v.lineBlockAtHeight(Math.max(0, top));
    const line = v.state.doc.lineAt(block.from).number - 1;
    const frac = block.height > 0 ? Math.min(1, Math.max(0, (top - block.top) / block.height)) : 0;
    return line + frac;
  }

  /** Where `topLine` would read `line`; the caller does the scrolling. */
  heightOfLine(line: number): number {
    const v = this.view;
    const n = Math.min(v.state.doc.lines, Math.max(1, Math.floor(line) + 1));
    const block = v.lineBlockAt(v.state.doc.line(n).from);
    return block.top + (line - Math.floor(line)) * block.height + v.documentPadding.top;
  }
}
