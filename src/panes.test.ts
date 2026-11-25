import { describe, expect, it } from "vitest";
import { close, MAX_PANES, panes, sanitize, single, split, type Layout } from "./panes";

type S = Extract<Layout, { kids: Layout[] }>;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("split", () => {
  it("turns a single pane into two, side by side or stacked", () => {
    expect(split(single(), 0, "row", 1)).toEqual({ dir: "row", kids: [{ pane: 0 }, { pane: 1 }], sizes: [0.5, 0.5] });
    expect(split(single(), 0, "column", 1)).toEqual({ dir: "column", kids: [{ pane: 0 }, { pane: 1 }], sizes: [0.5, 0.5] });
  });

  it("adds a sibling when the split already runs that way, halving the pane split", () => {
    const l = split(split(single(), 0, "row", 1), 1, "row", 2);
    expect(l).toEqual({ dir: "row", kids: [{ pane: 0 }, { pane: 1 }, { pane: 2 }], sizes: [0.5, 0.25, 0.25] });
  });

  it("nests a split the other way", () => {
    const l = split(split(single(), 0, "row", 1), 1, "column", 2);
    expect(l).toEqual({
      dir: "row",
      kids: [{ pane: 0 }, { dir: "column", kids: [{ pane: 1 }, { pane: 2 }], sizes: [0.5, 0.5] }],
      sizes: [0.5, 0.5],
    });
    expect(panes(l)).toEqual([0, 1, 2]);
  });
});

describe("close", () => {
  it("never closes pane 0", () => {
    const l = split(single(), 0, "row", 1);
    expect(close(l, 0)).toBe(l);
  });

  it("collapses a split left with one pane", () => {
    expect(close(split(single(), 0, "row", 1), 1)).toEqual({ pane: 0 });
  });

  it("gives the closed pane's room to its neighbour", () => {
    const l = split(split(single(), 0, "row", 1), 1, "row", 2); // 0.5 0.25 0.25
    const c = close(l, 2) as S;
    expect(panes(c)).toEqual([0, 1]);
    expect(c.sizes).toEqual([0.5, 0.5]);
  });

  it("gives a closed first pane's room to the next one", () => {
    const l: Layout = { dir: "row", kids: [{ pane: 1 }, { pane: 0 }, { pane: 2 }], sizes: [0.2, 0.3, 0.5] };
    const c = close(l, 1) as S;
    expect(panes(c)).toEqual([0, 2]);
    expect(c.sizes).toEqual([0.5, 0.5]);
  });

  it("merges a nested split into its parent when it runs the same way", () => {
    // row[0, column[1, row[2, 3]]] — closing 1 leaves row[0, row[2, 3]] → row[0, 2, 3]
    let l = split(single(), 0, "row", 1);
    l = split(l, 1, "column", 2);
    l = split(l, 2, "row", 3);
    const c = close(l, 1) as S;
    expect(c.dir).toBe("row");
    expect(panes(c)).toEqual([0, 2, 3]);
    expect(c.kids.every((k) => "pane" in k)).toBe(true);
    expect(sum(c.sizes)).toBeCloseTo(1);
    expect(c.sizes).toEqual([0.5, 0.25, 0.25]);
  });
});

describe("sanitize", () => {
  it("keeps a good layout", () => {
    const l = split(split(single(), 0, "row", 1), 1, "column", 2);
    expect(sanitize(JSON.parse(JSON.stringify(l)))).toEqual(l);
  });

  it("falls back to one pane for anything it cannot trust", () => {
    for (const bad of [
      undefined, null, 3, "row", {}, { pane: 1 }, { pane: -1 }, { pane: 0.5 },
      { dir: "row", kids: [{ pane: 0 }] },
      { dir: "diagonal", kids: [{ pane: 0 }, { pane: 1 }] },
      { dir: "row", kids: [{ pane: 0 }, { pane: 0 }] },
      { dir: "row", kids: [{ pane: 1 }, { pane: 2 }] },
      { dir: "row", kids: Array.from({ length: MAX_PANES + 1 }, (_, n) => ({ pane: n })) },
    ]) {
      expect(sanitize(bad)).toEqual(single());
    }
  });

  it("repairs sizes rather than throwing the layout away", () => {
    const l = sanitize({ dir: "column", kids: [{ pane: 0 }, { pane: 1 }], sizes: [-1, "x"] }) as S;
    expect(l.sizes).toEqual([0.5, 0.5]);
    const m = sanitize({ dir: "row", kids: [{ pane: 0 }, { pane: 1 }], sizes: [3, 1] }) as S;
    expect(m.sizes).toEqual([0.75, 0.25]);
  });
});
