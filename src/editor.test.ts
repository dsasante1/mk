import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { cycleHeading, insertLink, toggleWrap } from "./editor";

function apply(doc: string, from: number, to: number, f: (s: EditorState) => TransactionSpec) {
  const state = EditorState.create({ doc, selection: EditorSelection.single(from, to) });
  const next = state.update(f(state)).state;
  const r = next.selection.main;
  return { doc: next.doc.toString(), sel: next.doc.sliceString(r.from, r.to), from: r.from };
}

describe("formatting", () => {
  it("wraps, and unwraps from inside or outside", () => {
    expect(apply("make bold here", 5, 9, (s) => toggleWrap(s, "**"))).toMatchObject({ doc: "make **bold** here", sel: "bold" });
    expect(apply("make **bold** here", 7, 11, (s) => toggleWrap(s, "**"))).toMatchObject({ doc: "make bold here", sel: "bold" });
    expect(apply("make **bold** here", 5, 13, (s) => toggleWrap(s, "**"))).toMatchObject({ doc: "make bold here", sel: "bold" });
    expect(apply("x", 1, 1, (s) => toggleWrap(s, "*"))).toMatchObject({ doc: "x**", from: 2 });
  });
  it("makes links with the url ready to type", () => {
    expect(apply("see docs", 4, 8, insertLink)).toMatchObject({ doc: "see [docs](url)", sel: "url" });
    expect(apply("https://a.b", 0, 11, insertLink)).toMatchObject({ doc: "[](https://a.b)", from: 1 });
  });
  it("cycles headings", () => {
    expect(apply("Title", 0, 0, cycleHeading).doc).toBe("# Title");
    expect(apply("## Title", 0, 0, cycleHeading).doc).toBe("### Title");
    expect(apply("###### Title", 0, 0, cycleHeading).doc).toBe("Title");
  });
});
