import { describe, expect, it } from "vitest";
import {
  baseName, countWords, detectEol, dirName, isExternal, isMarkdownPath, readingMinutes,
  resolvePath, slugify, tildify, toggleTask, withEol,
} from "./text";

describe("line endings", () => {
  it("detects by majority and round-trips", () => {
    expect(detectEol("a\nb\n")).toBe("\n");
    expect(detectEol("a\r\nb\r\nc\n")).toBe("\r\n");
    expect(detectEol("no newline")).toBe("\n");
    expect(withEol("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");
    expect(withEol("a\nb", "\n")).toBe("a\nb");
  });
});

describe("words", () => {
  it("counts prose and skips fenced code", () => {
    expect(countWords("Hello, world! It's 2026.")).toBe(4);
    expect(countWords("One two\n\n```js\nconst a = b + c;\n```\nthree")).toBe(3);
    expect(countWords("~~~\ncode ``` still code\n~~~\nafter")).toBe(1);
    expect(countWords("")).toBe(0);
    expect(countWords("naïve café — déjà vu")).toBe(4);
  });
  it("rounds reading time up from zero", () => {
    expect(readingMinutes(0)).toBe(0);
    expect(readingMinutes(10)).toBe(1);
    expect(readingMinutes(1000)).toBe(4);
  });
});

describe("tasks", () => {
  it("flips the box and nothing else", () => {
    expect(toggleTask("- [ ] buy milk")).toEqual({ offset: 3, insert: "x" });
    expect(toggleTask("  * [x] done")).toEqual({ offset: 5, insert: " " });
    expect(toggleTask("1. [X] numbered")).toEqual({ offset: 4, insert: " " });
    expect(toggleTask("- plain item")).toBeNull();
    expect(toggleTask("[ ] not a list")).toBeNull();
  });
});

describe("paths", () => {
  it("splits and resolves", () => {
    expect(baseName("/a/b/c.md")).toBe("c.md");
    expect(dirName("/a/b/c.md")).toBe("/a/b");
    expect(dirName("/c.md")).toBe("/");
    expect(resolvePath("/docs/guide", "img/a.png")).toBe("/docs/guide/img/a.png");
    expect(resolvePath("/docs/guide", "../README.md#top")).toBe("/docs/README.md");
    expect(resolvePath("/docs", "./my%20notes.md")).toBe("/docs/my notes.md");
    expect(resolvePath("/docs", "/etc/x.md")).toBe("/etc/x.md");
    expect(resolvePath("/", "../../x.md")).toBe("/x.md");
    expect(tildify("/home/me/notes/a.md", "/home/me")).toBe("~/notes/a.md");
    expect(tildify("/home/meow/a.md", "/home/me")).toBe("/home/meow/a.md");
  });
  it("resolves Windows paths", () => {
    expect(dirName("C:\\Users\\me\\a.md")).toBe("C:\\Users\\me");
    expect(resolvePath("C:\\Users\\me\\docs", "img/a.png")).toBe("C:\\Users\\me\\docs\\img\\a.png");
    expect(resolvePath("C:\\Users\\me\\docs", "..\\README.md#top")).toBe("C:\\Users\\me\\README.md");
    expect(resolvePath("C:\\docs", "./my%20notes.md")).toBe("C:\\docs\\my notes.md");
    expect(resolvePath("C:\\docs", "/x.md")).toBe("C:\\x.md");
    expect(resolvePath("C:\\docs", "D:/other/x.md")).toBe("D:\\other\\x.md");
    expect(resolvePath("\\\\server\\share\\docs", "a.md")).toBe("\\\\server\\share\\docs\\a.md");
    expect(tildify("C:\\Users\\me\\notes\\a.md", "C:\\Users\\me")).toBe("~\\notes\\a.md");
  });
  it("classifies links", () => {
    expect(isExternal("https://x.org")).toBe(true);
    expect(isExternal("mailto:a@b.c")).toBe(true);
    expect(isExternal("//cdn.x/y.png")).toBe(true);
    expect(isExternal("docs/a.md")).toBe(false);
    expect(isMarkdownPath("a/B.MD")).toBe(true);
    expect(isMarkdownPath("a.md#x")).toBe(true);
    expect(isMarkdownPath("a.txt")).toBe(false);
  });
  it("slugs like GitHub", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("  What's `new` in 2.0?  ")).toBe("whats-new-in-20");
    expect(slugify("Ünïcode Heading")).toBe("ünïcode-heading");
  });
});
