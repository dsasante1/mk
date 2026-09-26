// The section rail: one short dash per heading at the edge of the page you
// are reading. The dash for the section you are in is longer and coloured,
// clicking a dash goes to its section, and hovering shows the headings by name.
//
// It reads positions as source lines, like scroll sync does, so the one rail
// serves the preview and the editor-only view alike: main.ts says which pane
// is being read and how to scroll it.

import type { Heading } from "./markdown";

/** A heading is current once its top is this far into the pane, in px. */
const REACH = 48;
/** How deep the rail goes below the document's top heading level. */
const DEPTH = 2;

export interface SectionNavHooks {
  /** The pane being read; its scroll position picks the current section. */
  scroller(): HTMLElement;
  /** The fractional, 0-based source line `offset` px below the pane's top. */
  lineAt(offset: number): number;
  /** Bring source line `line` to the top of the pane. */
  jump(line: number): void;
}

/** The headings worth a dash: the top level and the {@link DEPTH} below it. */
export function outline(all: Heading[]): Heading[] {
  if (all.length === 0) return [];
  const top = Math.min(...all.map((h) => h.level));
  return all.filter((h) => h.level <= top + DEPTH);
}

/**
 * The section being read: the last heading at or above `line`, or the last
 * heading of all when the pane is scrolled to its end, since a short closing
 * section can never reach the top. -1 while still above the first heading.
 */
export function activeSection(lines: number[], line: number, atEnd: boolean): number {
  if (lines.length === 0) return -1;
  if (atEnd) return lines.length - 1;
  let i = -1;
  while (i + 1 < lines.length && lines[i + 1] <= line) i++;
  return i;
}

const same = (a: Heading[], b: Heading[]) =>
  a.length === b.length && a.every((h, i) => h.line === b[i].line && h.level === b[i].level && h.text === b[i].text);

export class SectionNav {
  private items: Heading[] = [];
  private active = -1;
  /** The section last clicked, held until the user scrolls for themselves. */
  private pinned: number | null = null;
  private enabled = true;
  private frame = 0;
  private rail: HTMLElement;
  private menu: HTMLElement;

  constructor(readonly el: HTMLElement, private hooks: SectionNavHooks) {
    el.setAttribute("aria-label", "Sections");
    // The rail is for the mouse; the menu holds the real buttons, so the
    // keyboard and screen readers get one named stop per section, not two.
    this.rail = Object.assign(document.createElement("div"), { className: "sn-rail" });
    this.rail.setAttribute("aria-hidden", "true");
    this.menu = Object.assign(document.createElement("div"), { className: "sn-menu" });
    el.append(this.menu, this.rail);
    el.hidden = true;
    el.addEventListener("click", (e) => {
      const hit = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
      if (hit) this.go(Number(hit.dataset.index));
    });
    // Any scrolling of the user's own ends a pin; clicks inside the rail do not.
    const release = (e: Event) => {
      if (this.pinned === null || el.contains(e.target as Node)) return;
      this.pinned = null;
      this.update();
    };
    for (const type of ["wheel", "keydown", "pointerdown", "touchstart"]) {
      window.addEventListener(type, release, { capture: true, passive: true });
    }
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    this.paintVisibility();
    this.update();
  }

  /** New headings, after an edit or a new document. */
  set(all: Heading[]) {
    const next = outline(all);
    if (!same(next, this.items)) {
      this.items = next;
      this.pinned = null;
      this.active = -1;
      this.build();
    }
    this.paintVisibility();
    this.update();
  }

  /** Recompute the current section, at most once a frame. */
  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); });
  }

  update() {
    if (this.el.hidden) return;
    const pane = this.hooks.scroller();
    const atEnd = pane.scrollTop > 0 && pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2;
    const lines = this.items.map((h) => h.line);
    const i = this.pinned ?? activeSection(lines, this.hooks.lineAt(REACH), atEnd);
    if (i === this.active) return;
    this.active = i;
    this.paintActive();
  }

  private go(i: number) {
    const h = this.items[i];
    if (!h) return;
    this.pinned = i;
    this.hooks.jump(h.line);
    this.update();
  }

  private paintVisibility() {
    // One heading is not a set of sections to move between.
    this.el.hidden = !this.enabled || this.items.length < 2;
    this.el.parentElement?.classList.toggle("has-sections", !this.el.hidden);
  }

  private build() {
    const top = Math.min(...this.items.map((h) => h.level));
    const dashes: HTMLElement[] = [];
    const rows: HTMLElement[] = [];
    this.items.forEach((h, i) => {
      const depth = String(h.level - top);
      const dash = document.createElement("div");
      dash.className = "sn-dash";
      dash.dataset.index = String(i);
      dash.dataset.depth = depth;
      dashes.push(dash);
      const row = document.createElement("button");
      row.className = "sn-item";
      row.dataset.index = String(i);
      row.dataset.depth = depth;
      row.textContent = h.text || "Untitled section";
      rows.push(row);
    });
    this.rail.replaceChildren(...dashes);
    this.menu.replaceChildren(...rows);
  }

  private paintActive() {
    for (const box of [this.rail, this.menu]) {
      [...box.children].forEach((c, n) => {
        const on = n === this.active;
        c.classList.toggle("on", on);
        if (on) c.setAttribute("aria-current", "location");
        else c.removeAttribute("aria-current");
        if (on) keepInView(box, c as HTMLElement);
      });
    }
  }
}

/**
 * Scroll `box` just enough to show `child`. Not `scrollIntoView`, which would
 * also scroll every overflow-hidden ancestor up to the window.
 */
function keepInView(box: HTMLElement, child: HTMLElement) {
  const top = child.offsetTop;
  const bottom = top + child.offsetHeight;
  if (top < box.scrollTop) box.scrollTop = top;
  else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
}
