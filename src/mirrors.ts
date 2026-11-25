// Extra editor panes on the same document.
//
// The primary editor stays the one source of truth: Harper, the preview, auto
// save and undo all hang off it. A mirror is a second CodeMirror view with its
// own selection and scroll. What is typed in a mirror is applied there and
// passed to the primary, as an ordinary transaction, so it lands in the
// primary's undo history; the primary passes every change it makes on to the
// other mirrors, never back to where it came from. This is CodeMirror's own
// recipe for a split view, generalised to several.

import { Annotation, Transaction, type EditorState, type TransactionSpec } from "@codemirror/state";

/** On a passed-on change: the pane it came from, 0 for the primary. */
export const fromPane = Annotation.define<number>();

export interface Surface {
  readonly state: EditorState;
  dispatch(spec: TransactionSpec): void;
}

interface Mirror {
  view: Surface;
  /** Start over from this text: a new document, or one that drifted. */
  reset(text: string): void;
}

export class Mirrors {
  private panes = new Map<number, Mirror>();
  private passing = false;

  constructor(private primary: () => Surface) {}

  add(id: number, view: Surface, reset: (text: string) => void) {
    this.panes.set(id, { view, reset });
    reset(this.primary().state.doc.toString());
  }

  remove(id: number) { this.panes.delete(id); }

  get size() { return this.panes.size; }

  /** From the primary's update listener. */
  fromPrimary(trs: readonly Transaction[]) {
    if (this.panes.size === 0) return;
    this.pass(() => {
      for (const tr of trs) {
        if (tr.changes.empty) continue;
        const origin = tr.annotation(fromPane);
        for (const [id, m] of this.panes) {
          if (id === origin) continue;
          // One that has drifted cannot take the change; it is put right below.
          if (m.view.state.doc.length !== tr.changes.length) continue;
          m.view.dispatch({ changes: tr.changes, annotations: fromPane.of(0) });
        }
      }
    });
  }

  /** From a mirror's dispatch, after it has applied `trs` to itself. */
  fromMirror(id: number, trs: readonly Transaction[]) {
    const own = trs.filter((tr) => !tr.changes.empty && tr.annotation(fromPane) === undefined);
    if (own.length === 0) return;
    this.pass(() => {
      for (const tr of own) {
        if (this.primary().state.doc.length !== tr.changes.length) break;
        // Typing is passed on without its label, which is what the primary's
        // indent-on-input acts on: an edit made there would not come
        // back here (the check after puts that right). Unlabelled, it still
        // joins the run of typing for undo.
        const ue = tr.annotation(Transaction.userEvent);
        const annotations: Annotation<unknown>[] = [fromPane.of(id)];
        if (ue && !/^input\.type($|\.)/.test(ue)) annotations.push(Transaction.userEvent.of(ue));
        this.primary().dispatch({ changes: tr.changes, annotations });
      }
    });
  }

  /**
   * Passing a change on sets off more passing (primary → mirror → primary's
   * listener). Only the outermost pass checks, once every pane has had its
   * share: a check halfway would find the panes not yet reached "drifted".
   */
  private pass(run: () => void) {
    if (this.passing) { run(); return; }
    this.passing = true;
    try { run(); } finally { this.passing = false; }
    this.check();
  }

  /** The primary has a new state; every mirror follows. */
  resetAll() {
    const text = this.primary().state.doc.toString();
    for (const m of this.panes.values()) m.reset(text);
  }

  /** Belt and braces: a mirror that does not match the primary starts again from it. */
  private check() {
    const doc = this.primary().state.doc;
    for (const m of this.panes.values()) {
      if (!m.view.state.doc.eq(doc)) m.reset(doc.toString());
    }
  }
}
