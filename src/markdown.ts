// Markdown → HTML for the preview.
//
// markdown-it with GitHub's habits added: task lists, heading anchors and
// highlighted fences. The one thing it does that a plain renderer does not is
// stamp each block with the source line it came from (`data-line`), which is
// what scroll sync and clicking a checkbox both stand on. A block without it
// is a block the preview cannot line up with the editor.
//
// Output is NOT safe to insert as-is; `preview.ts` sanitises it. Raw HTML in
// Markdown is allowed on purpose — READMEs are full of `<details>` and
// centred logos — and sanitising is the price.

import markdownit, { type MarkdownIt, type Token } from "markdown-it";
import hljs from "highlight.js/lib/common";
import { slugify } from "./text";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function highlight(code: string, lang: string): string {
  const name = lang.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (name && hljs.getLanguage(name)) {
    try {
      return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
    } catch { /* fall through to plain */ }
  }
  return escapeHtml(code);
}

/** Every opening block tag carries its first source line. */
function sourceLines(md: MarkdownIt) {
  md.core.ruler.push("source_lines", (state) => {
    for (const t of state.tokens) {
      if (t.map && t.block && (t.nesting === 1 || t.nesting === 0) && t.type !== "inline") {
        t.attrSet("data-line", String(t.map[0]));
      }
    }
  });
  // The default fence renderer puts attributes on the inner <code>, which is
  // fine for lookup, but the <pre> is the box that has a position worth
  // scrolling to.
  md.renderer.rules.fence = (tokens, idx, options) => {
    const t = tokens[idx];
    const info = t.info ? md.utils.unescapeAll(t.info).trim() : "";
    const lang = info.split(/\s+/)[0] ?? "";
    const body = options.highlight ? options.highlight(t.content, lang, "") : escapeHtml(t.content);
    const cls = lang ? ` class="hljs language-${escapeHtml(lang)}"` : ` class="hljs"`;
    const line = t.attrGet("data-line");
    return `<pre${line !== null ? ` data-line="${line}"` : ""}><code${cls}>${body}</code></pre>\n`;
  };
}

/** GitHub-style ids on headings, de-duplicated with -1, -2, … */
function headingIds(md: MarkdownIt) {
  md.core.ruler.push("heading_ids", (state) => {
    const seen = new Map<string, number>();
    const toks = state.tokens;
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== "heading_open") continue;
      const inline = toks[i + 1];
      const text = inline?.children?.filter((c) => c.type === "text" || c.type === "code_inline").map((c) => c.content).join("") ?? "";
      const base = slugify(text) || "section";
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      toks[i].attrSet("id", n === 0 ? base : `${base}-${n}`);
    }
  });
}

/**
 * `- [ ]` and `- [x]` as checkboxes. The box carries its list item's source
 * line so a click can flip the character in the editor; it is not `disabled`,
 * because a disabled input swallows the click that would say so.
 */
function taskLists(md: MarkdownIt) {
  md.core.ruler.after("inline", "task_lists", (state) => {
    const toks = state.tokens;
    for (let i = 2; i < toks.length; i++) {
      const inline = toks[i];
      if (inline.type !== "inline" || toks[i - 1].type !== "paragraph_open" || toks[i - 2].type !== "list_item_open") continue;
      const first = inline.children?.[0];
      if (!first || first.type !== "text") continue;
      const m = /^\[([ xX])\](?=\s|$)/.exec(first.content);
      if (!m) continue;
      first.content = first.content.slice(3).replace(/^\s/, "");
      const item: Token = toks[i - 2];
      const line = item.map ? item.map[0] : -1;
      const box = new state.Token("html_inline", "", 0);
      box.content = `<input type="checkbox" class="task-box"${m[1] !== " " ? " checked" : ""} data-task-line="${line}">`;
      inline.children!.unshift(box);
      item.attrJoin("class", "task-item");
      // Mark the list itself, so its bullets can be hidden.
      for (let j = i - 3; j >= 0; j--) {
        const t = toks[j];
        if ((t.type === "bullet_list_open" || t.type === "ordered_list_open") && t.level === item.level - 1) {
          if (!String(t.attrGet("class") ?? "").includes("task-list")) t.attrJoin("class", "task-list");
          break;
        }
      }
    }
  });
}

/** Front matter shown as what it is, rather than as a rule and a heading. */
function frontMatter(src: string): { meta: string | null; body: string; offset: number } {
  const m = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(src);
  if (!m) return { meta: null, body: src, offset: 0 };
  return { meta: m[1], body: src.slice(m[0].length), offset: m[0].split("\n").length - 1 };
}

export function createRenderer(): MarkdownIt {
  const md = markdownit({ html: true, linkify: true, typographer: false, highlight });
  md.use(sourceLines).use(headingIds).use(taskLists);
  return md;
}

let shared: MarkdownIt | null = null;

export function render(src: string): string {
  shared ??= createRenderer();
  const { meta, body, offset } = frontMatter(src);
  const env = {};
  const tokens = shared.parse(body, env);
  if (offset) {
    // The body was parsed without the front matter, so its lines are short
    // by the header's length; put them back where the editor has them.
    for (const t of tokens) {
      if (t.map) t.map = [t.map[0] + offset, t.map[1] + offset];
      const line = t.attrGet("data-line");
      if (line !== null) t.attrSet("data-line", String(Number(line) + offset));
      if (t.children) for (const c of t.children) {
        if (c.type === "html_inline") c.content = c.content.replace(/data-task-line="(\d+)"/, (_: string, n: string) => `data-task-line="${Number(n) + offset}"`);
      }
    }
  }
  const html = shared.renderer.render(tokens, shared.options, env);
  if (meta === null) return html;
  return `<pre class="front-matter" data-line="0"><code>${escapeHtml(meta)}</code></pre>\n${html}`;
}
