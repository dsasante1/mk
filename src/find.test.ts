import { describe, expect, it } from "vitest";
import { findAll, spans, startIndex } from "./find";

describe("findAll", () => {
  it("ignores case unless asked not to", () => {
    expect(findAll("Mark mark MARK", "mark", false)).toEqual([{ from: 0, to: 4 }, { from: 5, to: 9 }, { from: 10, to: 14 }]);
    expect(findAll("Mark mark MARK", "mark", true)).toEqual([{ from: 5, to: 9 }]);
  });

  it("takes the query literally", () => {
    expect(findAll("a.b axb (c) [d]", "a.b", false)).toEqual([{ from: 0, to: 3 }]);
    expect(findAll("a.b axb (c) [d]", "(c)", false)).toEqual([{ from: 8, to: 11 }]);
    expect(findAll("x-y \\z", "\\z", false)).toEqual([{ from: 4, to: 6 }]);
  });

  it("does not overlap matches", () => {
    expect(findAll("aaaa", "aa", false)).toEqual([{ from: 0, to: 2 }, { from: 2, to: 4 }]);
  });

  it("finds nothing for an empty query and stops at the limit", () => {
    expect(findAll("abc", "", false)).toEqual([]);
    expect(findAll("a a a a", "a", false, 2)).toHaveLength(2);
  });
});

describe("startIndex", () => {
  const m = [{ from: 2, to: 4 }, { from: 10, to: 12 }];

  it("is the first match at or after the position", () => {
    expect(startIndex(m, 0)).toBe(0);
    expect(startIndex(m, 2)).toBe(0);
    expect(startIndex(m, 3)).toBe(1);
  });

  it("wraps past the last match, and is -1 with none", () => {
    expect(startIndex(m, 11)).toBe(0);
    expect(startIndex([], 0)).toBe(-1);
  });
});

describe("spans", () => {
  it("places a match inside one piece", () => {
    expect(spans([5, 5], [{ from: 6, to: 8 }])).toEqual([[{ piece: 1, from: 1, to: 3 }]]);
  });

  it("splits a match across the pieces it covers, skipping empty ones", () => {
    // "foo " + "" + "bar" + "!" — "o bar!" runs over three.
    expect(spans([4, 0, 3, 1], [{ from: 2, to: 8 }])).toEqual([[
      { piece: 0, from: 2, to: 4 }, { piece: 2, from: 0, to: 3 }, { piece: 3, from: 0, to: 1 },
    ]]);
  });

  it("lets matches share a piece", () => {
    expect(spans([6], [{ from: 0, to: 2 }, { from: 4, to: 6 }])).toEqual([
      [{ piece: 0, from: 0, to: 2 }], [{ piece: 0, from: 4, to: 6 }],
    ]);
  });
});
