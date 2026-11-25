import { describe, expect, it } from "vitest";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { Mirrors, type Surface } from "./mirrors";

/** A view without a DOM: applies what it is sent, then reports it, as the app's views do. */
class Fake implements Surface {
  constructor(public state: EditorState, private after: (trs: readonly Transaction[]) => void) {}
  // A property, not a method: commands like undo call it unbound, as `dispatch(tr)`.
  dispatch = (spec: TransactionSpec | Transaction) => {
    const tr = spec instanceof Transaction ? spec : this.state.update(spec);
    this.state = tr.state;
    this.after([tr]);
  };
}

function setup(text = "hello", n = 2) {
  let mirrors!: Mirrors;
  const primary = new Fake(EditorState.create({ doc: text, extensions: [history()] }), (trs) => mirrors.fromPrimary(trs));
  mirrors = new Mirrors(() => primary);
  const panes: Fake[] = [];
  for (let id = 1; id <= n; id++) {
    const m = new Fake(EditorState.create({ doc: "" }), (trs) => mirrors.fromMirror(id, trs));
    mirrors.add(id, m, (t) => { m.state = EditorState.create({ doc: t }); });
    panes.push(m);
  }
  const texts = () => [primary, ...panes].map((v) => v.state.doc.toString());
  return { primary, panes, mirrors, texts };
}

describe("Mirrors", () => {
  it("starts a mirror from the primary's text", () => {
    const { texts } = setup("hello");
    expect(texts()).toEqual(["hello", "hello", "hello"]);
  });

  it("passes the primary's edits to every mirror", () => {
    const { primary, texts } = setup("hello");
    primary.dispatch({ changes: { from: 5, insert: " world" } });
    expect(texts()).toEqual(["hello world", "hello world", "hello world"]);
  });

  it("passes a mirror's edit to the primary and the other mirrors, once each", () => {
    const { panes, texts } = setup("hello");
    panes[0].dispatch({ changes: { from: 0, insert: "oh " }, userEvent: "input.type" });
    expect(texts()).toEqual(["oh hello", "oh hello", "oh hello"]);
    panes[1].dispatch({ changes: { from: 8, insert: "!" }, userEvent: "input.paste" });
    expect(texts()).toEqual(["oh hello!", "oh hello!", "oh hello!"]);
  });

  it("puts a mirror's edit in the primary's undo history, and undo reaches every pane", () => {
    const { primary, panes, texts } = setup("hello");
    panes[0].dispatch({ changes: { from: 5, insert: "!" }, userEvent: "input.paste" });
    expect(undo(primary)).toBe(true);
    expect(texts()).toEqual(["hello", "hello", "hello"]);
    expect(redo(primary)).toBe(true);
    expect(texts()).toEqual(["hello!", "hello!", "hello!"]);
  });

  it("keeps several edits in one dispatch in order", () => {
    const { panes, mirrors, primary, texts } = setup("abc");
    const m = panes[0];
    const t1 = m.state.update({ changes: { from: 3, insert: "d" } });
    const t2 = t1.state.update({ changes: { from: 0, insert: "_" } });
    m.state = t2.state;
    mirrors.fromMirror(1, [t1, t2]);
    expect(primary.state.doc.toString()).toBe("_abcd");
    expect(texts()).toEqual(["_abcd", "_abcd", "_abcd"]);
  });

  it("resets a mirror that drifted from the primary", () => {
    const { primary, panes, mirrors, texts } = setup("hello");
    panes[1].state = EditorState.create({ doc: "something else" });
    primary.dispatch({ changes: { from: 0, insert: ">" } });
    expect(texts()).toEqual([">hello", ">hello", ">hello"]);
    expect(mirrors.size).toBe(2);
  });

  it("follows the primary to a new document, and stops passing to a removed mirror", () => {
    const { primary, panes, mirrors, texts } = setup("hello");
    primary.state = EditorState.create({ doc: "another file" });
    mirrors.resetAll();
    expect(texts()).toEqual(["another file", "another file", "another file"]);
    mirrors.remove(2);
    primary.dispatch({ changes: { from: 0, insert: "#" } });
    expect(panes[0].state.doc.toString()).toBe("#another file");
    expect(panes[1].state.doc.toString()).toBe("another file");
  });
});
