// Harper in the editor: when to ask, what to do with the answer, and the
// actions an issue offers.
//
// A lint is asked for after a pause in typing and answered by the Rust thread
// in a few milliseconds — but the user may have typed in those milliseconds.
// Every change made while a lint is in flight is composed into `pending`, and
// the answer is mapped through it before it is shown. An issue whose own text
// was edited meanwhile is dropped rather than moved: its finding was about
// words that no longer exist. Requests are numbered, and an answer to
// anything but the newest is discarded.

import { ChangeSet, type ChangeDesc } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { setDiagnostics, type Diagnostic, type Action } from "@codemirror/lint";
import { api, type Issue } from "./api";

export type Group = "spelling" | "grammar" | "style";

/**
 * Harper's twenty-odd kinds, folded to the three a writer triages by: a
 * word that is wrong, a sentence that is wrong, and a sentence that could be
 * better. Anything Harper adds later lands in style, the mildest.
 */
export function groupOf(kind: string): Group {
  switch (kind) {
    case "Spelling": case "Typo":
      return "spelling";
    case "Grammar": case "Agreement": case "Malapropism": case "Eggcorn": case "WordOrder":
    case "BoundaryError": case "Capitalization": case "Punctuation": case "Usage":
    case "Repetition": case "Nonstandard":
      return "grammar";
    default:
      return "style";
  }
}

const SEVERITY: Record<Group, Diagnostic["severity"]> = { spelling: "error", grammar: "warning", style: "info" };

export const GROUP_LABEL: Record<Group, string> = { spelling: "Spelling", grammar: "Grammar", style: "Style" };

/** Split a rule's CamelCase name into words for display. */
export function ruleLabel(rule: string): string {
  return rule.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

/**
 * Map issues through edits made since they were computed. Touched issues are
 * dropped; the rest move, and so do their fixes, which sit at or inside the
 * issue's range.
 */
export function mapIssues(issues: Issue[], changes: ChangeDesc): Issue[] {
  if (changes.empty) return issues;
  const out: Issue[] = [];
  for (const i of issues) {
    if (changes.touchesRange(i.from, i.to)) continue;
    const from = changes.mapPos(i.from, 1);
    const to = changes.mapPos(i.to, -1);
    if (to < from) continue;
    const fixes = i.fixes.map((f) => ({ ...f, from: from + (f.from - i.from), to: to + (f.to - i.to) }));
    out.push({ ...i, from, to, fixes });
  }
  return out;
}

export interface GrammarHooks {
  /** The document's path, for per-file ignores; null while untitled. */
  path(): string | null;
  onIssues(issues: Issue[], state: "checking" | "ready" | "off" | "error"): void;
  disableRule(rule: string): Promise<void>;
  toast(msg: string): void;
}

export class Grammar {
  issues: Issue[] = [];
  enabled = true;
  private gen = 0;
  private timer: number | undefined;
  private pending: ChangeSet | null = null;
  private ignored = new Set<string>();

  constructor(private view: () => EditorView, private hooks: GrammarHooks) {}

  /** Called with every document change. */
  changed(changes: ChangeSet) {
    if (this.pending) this.pending = this.pending.compose(changes);
    if (!changes.empty && this.enabled) {
      this.issues = mapIssues(this.issues, changes);
      this.hooks.onIssues(this.issues, "checking");
    }
    this.schedule();
  }

  schedule(delay = 400) {
    window.clearTimeout(this.timer);
    if (!this.enabled) return;
    this.timer = window.setTimeout(() => void this.run(), delay);
  }

  /** A fresh document: forget everything, load its ignores, lint at once. */
  async reset(path: string | null) {
    this.gen++;
    this.pending = null;
    this.issues = [];
    this.ignored = new Set(path ? await api.ignoredGet(path).catch(() => []) : []);
    this.publish(this.enabled ? "checking" : "off");
    this.schedule(0);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (on) { this.schedule(0); return; }
    window.clearTimeout(this.timer);
    this.gen++;
    this.issues = [];
    this.publish("off");
  }

  async run() {
    if (!this.enabled) return;
    const view = this.view();
    const text = view.state.doc.toString();
    const g = ++this.gen;
    this.pending = ChangeSet.empty(text.length);
    let result: Issue[];
    try {
      result = await api.lint(text);
    } catch (e) {
      if (String(e) === "superseded" || g !== this.gen) return;
      this.hooks.onIssues(this.issues, "error");
      return;
    }
    if (g !== this.gen) return;
    const since = this.pending ?? ChangeSet.empty(text.length);
    this.pending = null;
    this.issues = mapIssues(result.filter((i) => !this.ignored.has(i.hash)), since);
    this.publish("ready");
  }

  private publish(state: "checking" | "ready" | "off" | "error") {
    const view = this.view();
    view.dispatch(setDiagnostics(view.state, this.issues.map((i) => this.diagnostic(i))));
    this.hooks.onIssues(this.issues, state);
  }

  // ---- actions ----

  /** Apply a fix by index into the issue's fixes. One change, one undo step. */
  fix(issue: Issue, index: number) {
    const f = issue.fixes[index];
    if (!f) return;
    const view = this.view();
    view.dispatch({
      changes: { from: f.from, to: f.to, insert: f.insert },
      selection: { anchor: f.from + f.insert.length },
      userEvent: "input.harper",
    });
    view.focus();
  }

  async ignore(issue: Issue) {
    this.ignored.add(issue.hash);
    const path = this.hooks.path();
    if (path) await api.ignoreAdd(path, issue.hash).catch((e) => this.hooks.toast(String(e)));
    this.issues = this.issues.filter((i) => i.hash !== issue.hash);
    this.publish("ready");
  }

  async clearIgnored() {
    this.ignored.clear();
    const path = this.hooks.path();
    if (path) await api.ignoreClear(path).catch(() => {});
    this.schedule(0);
  }

  get ignoredCount() { return this.ignored.size; }

  async addWord(issue: Issue) {
    try {
      await api.wordAdd(issue.text);
      this.hooks.toast(`Added “${issue.text}” to your dictionary`);
      // Hide it now; the relint that follows confirms it.
      this.issues = this.issues.filter((i) => !(groupOf(i.kind) === "spelling" && i.text === issue.text));
      this.publish("checking");
      this.schedule(0);
    } catch (e) {
      this.hooks.toast(String(e));
    }
  }

  async disableRule(issue: Issue) {
    await this.hooks.disableRule(issue.rule);
    this.issues = this.issues.filter((i) => i.rule !== issue.rule);
    this.publish("checking");
    this.hooks.toast(`Turned off “${ruleLabel(issue.rule)}” — re-enable it in Settings`);
    this.schedule(0);
  }

  /** Everything an issue offers, fixes first, as label/run pairs. */
  actions(issue: Issue): { label: string; kind: "fix" | "other"; run: () => void }[] {
    const out: { label: string; kind: "fix" | "other"; run: () => void }[] = issue.fixes
      .slice(0, 6)
      .map((f, n) => ({ label: f.label, kind: "fix", run: () => this.fix(issue, n) }));
    if (groupOf(issue.kind) === "spelling" && /^\S+$/.test(issue.text)) {
      out.push({ label: `Add “${issue.text}” to dictionary`, kind: "other", run: () => void this.addWord(issue) });
    }
    out.push({ label: "Ignore here", kind: "other", run: () => void this.ignore(issue) });
    out.push({ label: `Turn off ${ruleLabel(issue.rule)}`, kind: "other", run: () => void this.disableRule(issue) });
    return out;
  }

  /**
   * The CodeMirror diagnostic for an issue. Its actions look the issue up
   * again by position when clicked, because CodeMirror has mapped the
   * diagnostic through any edits since and our copy may be stale.
   */
  private diagnostic(issue: Issue): Diagnostic {
    const group = groupOf(issue.kind);
    const actions: Action[] = this.actions(issue).map((a) => ({
      name: a.label,
      markClass: a.kind === "fix" ? "hp-action-fix" : "hp-action-other",
      apply: (_view, from, to) => {
        const live = this.issues.find((i) => i.hash === issue.hash && i.from === from && i.to === to)
          ?? this.issues.find((i) => i.hash === issue.hash);
        if (!live) return;
        const again = this.actions(live).find((x) => x.label === a.label);
        again?.run();
      },
    }));
    return {
      from: issue.from,
      to: Math.max(issue.to, issue.from),
      severity: SEVERITY[group],
      markClass: `hp-mark hp-${group}`,
      source: `Harper · ${ruleLabel(issue.rule)}`,
      message: issue.message,
      renderMessage: () => renderMessage(issue),
      actions,
    };
  }

  /** Issues under a position, innermost first. */
  at(pos: number): Issue[] {
    return this.issues
      .filter((i) => i.from <= pos && pos <= i.to)
      .sort((a, b) => (a.to - a.from) - (b.to - b.from));
  }

  next(pos: number, dir: 1 | -1): Issue | null {
    if (this.issues.length === 0) return null;
    const sorted = [...this.issues].sort((a, b) => a.from - b.from);
    if (dir === 1) return sorted.find((i) => i.from > pos) ?? sorted[0];
    return [...sorted].reverse().find((i) => i.to < pos) ?? sorted[sorted.length - 1];
  }
}

/**
 * Harper writes its messages in Markdown — mostly backticks around the word
 * in question. Rendered as code spans by hand rather than through the preview
 * renderer: a message is one line, and it goes in a tooltip.
 */
export function renderMessage(issue: Issue): HTMLElement {
  const el = document.createElement("div");
  el.className = "hp-message";
  const head = document.createElement("div");
  head.className = `hp-kind hp-${groupOf(issue.kind)}`;
  head.textContent = `${GROUP_LABEL[groupOf(issue.kind)]} · ${ruleLabel(issue.rule)}`;
  const body = document.createElement("div");
  body.className = "hp-text";
  for (const [n, part] of issue.message.split("`").entries()) {
    if (n % 2 === 1) {
      const code = document.createElement("code");
      code.textContent = part;
      body.append(code);
    } else {
      body.append(part.replace(/\*\*?([^*]+)\*\*?/g, "$1"));
    }
  }
  el.append(head, body);
  return el;
}
