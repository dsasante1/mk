import { describe, expect, it } from "vitest";
import { activeSection, outline } from "./section-nav";

const h = (line: number, level: number) => ({ line, level, text: `h${line}` });

describe("outline", () => {
  it("keeps the top level and two below it", () => {
    const all = [h(0, 2), h(3, 3), h(5, 4), h(7, 5), h(9, 2)];
    expect(outline(all).map((x) => x.line)).toEqual([0, 3, 5, 9]);
  });

  it("is empty for a document without headings", () => {
    expect(outline([])).toEqual([]);
  });
});

describe("activeSection", () => {
  const lines = [4, 10, 20];

  it("is none above the first heading", () => {
    expect(activeSection(lines, 2, false)).toBe(-1);
  });

  it("is the last heading at or above the line", () => {
    expect(activeSection(lines, 4, false)).toBe(0);
    expect(activeSection(lines, 12.5, false)).toBe(1);
    expect(activeSection(lines, 99, false)).toBe(2);
  });

  it("is the last heading at the end of the pane", () => {
    expect(activeSection(lines, 12, true)).toBe(2);
  });

  it("is none without headings", () => {
    expect(activeSection([], 5, true)).toBe(-1);
  });
});
