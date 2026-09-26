// The rendered side: sanitise, point images at the disk, route clicks, and
// line up with the editor.
//
// Markdown may carry raw HTML, and a document opened from a download folder
// is not trusted. DOMPurify strips scripts and handlers, the CSP in
// tauri.conf.json refuses inline script as a second line, and heading ids are
// namespaced (`user-content-…`, as GitHub does) so a heading called "Title"
// cannot clobber `document.title`.

import DOMPurify from "dompurify";
import { convertFileSrc } from "@tauri-apps/api/core";
import { render } from "./markdown";
import { isExternal, resolvePath } from "./text";

const ID_PREFIX = "user-content-";

export interface PreviewHooks {
  toggleTask(line: number): void;
  openLink(href: string): void;
}

export class Preview {
  private dir: string | null = null;
  private blocks: { line: number; el: HTMLElement }[] = [];
  private lastSrc: string | null = null;

  constructor(readonly el: HTMLElement, readonly pane: HTMLElement, private hooks: PreviewHooks) {
    el.addEventListener("click", (e) => this.onClick(e));
  }

  setDir(dir: string | null) {
    if (dir !== this.dir) { this.dir = dir; this.lastSrc = null; }
  }

  render(src: string) {
    if (src === this.lastSrc) return;
    this.lastSrc = src;
    const html = DOMPurify.sanitize(render(src), {
      SANITIZE_NAMED_PROPS: true,
      ADD_ATTR: ["data-line", "data-task-line"],
      FORBID_TAGS: ["style", "form"],
    });
    this.el.innerHTML = html;
    if (!src.trim()) {
      this.el.innerHTML = `<p class="empty">Nothing to preview yet.</p>`;
    }
    for (const img of this.el.querySelectorAll("img")) this.fixImage(img);
    this.blocks = [...this.el.querySelectorAll<HTMLElement>("[data-line]")]
      .map((el) => ({ line: Number(el.dataset.line), el }))
      .filter((b) => Number.isFinite(b.line))
      .sort((a, b) => a.line - b.line);
  }

  /** Relative and absolute paths load from disk through the asset protocol. */
  private fixImage(img: HTMLImageElement) {
    const src = img.getAttribute("src") ?? "";
    img.loading = "lazy";
    if (!src || isExternal(src) || src.startsWith("data:")) return;
    if (!this.dir && !src.startsWith("/")) { img.classList.add("unresolved"); return; }
    img.src = convertFileSrc(resolvePath(this.dir ?? "/", src));
  }

  private onClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const box = target.closest<HTMLInputElement>("input.task-box");
    if (box) {
      e.preventDefault();
      const line = Number(box.dataset.taskLine);
      if (line >= 0) this.hooks.toggleTask(line);
      return;
    }
    const a = target.closest<HTMLAnchorElement>("a[href]");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) { this.scrollToAnchor(href.slice(1)); return; }
    this.hooks.openLink(href);
  }

  scrollToAnchor(id: string) {
    let name = id;
    try { name = decodeURIComponent(id); } catch { /* as written */ }
    const el = document.getElementById(ID_PREFIX + name) ?? document.getElementById(name);
    if (el) this.pane.scrollTo({ top: el.offsetTop - 16, behavior: "smooth" });
  }

  get directory() { return this.dir; }

  // ---- scroll sync, in 0-based fractional source lines ----

  /** An element's offset in the pane's scroll coordinates. */
  private top(el: HTMLElement): number {
    return el.getBoundingClientRect().top - this.pane.getBoundingClientRect().top + this.pane.scrollTop;
  }

  /** The pane scrollTop at which source line `line` is at the top. */
  heightOfLine(line: number): number {
    const b = this.blocks;
    if (b.length === 0) return 0;
    let i = 0;
    while (i + 1 < b.length && b[i + 1].line <= line) i++;
    const cur = b[i];
    const next = b[i + 1];
    const curTop = this.top(cur.el);
    if (line < cur.line) return 0;
    if (!next) {
      // Past the last block: move through it in proportion to its height.
      const span = Math.max(1, this.lastLine() - cur.line);
      return curTop + Math.min(1, (line - cur.line) / span) * cur.el.offsetHeight;
    }
    const nextTop = this.top(next.el);
    return curTop + ((line - cur.line) / (next.line - cur.line)) * (nextTop - curTop);
  }

  /** The inverse: which source line sits at the pane's top, or `offset` px below it. */
  topLine(offset = 0): number {
    const b = this.blocks;
    if (b.length === 0) return 0;
    const y = this.pane.scrollTop + offset;
    let i = 0;
    while (i + 1 < b.length && this.top(b[i + 1].el) <= y) i++;
    const cur = b[i];
    const next = b[i + 1];
    const curTop = this.top(cur.el);
    if (y < curTop) return cur.line * (y / Math.max(1, curTop));
    if (!next) {
      const span = Math.max(1, this.lastLine() - cur.line);
      return cur.line + Math.min(1, (y - curTop) / Math.max(1, cur.el.offsetHeight)) * span;
    }
    const nextTop = this.top(next.el);
    return cur.line + ((y - curTop) / Math.max(1, nextTop - curTop)) * (next.line - cur.line);
  }

  private lastLine(): number {
    return (this.lastSrc ?? "").split("\n").length;
  }
}
