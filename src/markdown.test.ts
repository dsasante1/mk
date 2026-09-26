import { describe, expect, it } from "vitest";
import { headings, render } from "./markdown";

describe("render", () => {
  it("stamps blocks with their source line", () => {
    const html = render("# Title\n\nPara one.\n\n- a\n- b\n\n```js\nx\n```\n");
    expect(html).toContain('<h1 data-line="0" id="title">');
    expect(html).toContain('<p data-line="2">');
    expect(html).toContain('<ul data-line="4">');
    expect(html).toMatch(/<pre data-line="7"><code class="hljs language-js">/);
  });

  it("renders task lists with their line", () => {
    const html = render("Intro\n\n- [ ] todo\n- [x] done\n- plain\n");
    expect(html).toContain('class="task-list"');
    expect(html).toContain('<input type="checkbox" class="task-box" data-task-line="2">');
    expect(html).toContain('<input type="checkbox" class="task-box" checked data-task-line="3">');
    expect(html).not.toContain("[ ]");
    expect(html).toContain("plain");
  });

  it("de-duplicates heading ids", () => {
    const html = render("## Usage\n\n## Usage\n");
    expect(html).toContain('id="usage"');
    expect(html).toContain('id="usage-1"');
  });

  it("keeps line numbers right after front matter", () => {
    const html = render("---\ntitle: x\n---\n# Heading\n\n- [ ] t\n");
    expect(html).toContain('class="front-matter"');
    expect(html).toContain('<h1 data-line="3"');
    expect(html).toContain('data-task-line="5"');
  });

  it("does GFM tables, strikethrough and links", () => {
    const html = render("| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~ https://example.com\n");
    expect(html).toContain("<table");
    expect(html).toContain("<s>gone</s>");
    expect(html).toContain('<a href="https://example.com">');
  });

  it("escapes code in unknown languages", () => {
    expect(render("```nosuchlang\n<b>x</b>\n```\n")).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("headings", () => {
  it("finds ATX and setext headings with their line and plain text", () => {
    expect(headings("# One\n\ntext\n\nTwo **bold** `code`\n---\n\n### Three\n")).toEqual([
      { line: 0, level: 1, text: "One" },
      { line: 4, level: 2, text: "Two bold code" },
      { line: 7, level: 3, text: "Three" },
    ]);
  });

  it("skips a # inside code and counts lines after front matter", () => {
    expect(headings("---\ntitle: x\n---\n```sh\n# not a heading\n```\n## Real\n")).toEqual([
      { line: 6, level: 2, text: "Real" },
    ]);
  });
});
