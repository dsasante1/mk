// Split panes: the editor side and the preview side can each be divided into
// several panes, side by side or stacked, and those divided again.
//
// A side's layout is a tree. A leaf is one pane, named by a number; pane 0 is
// the side's original pane, the one the rest of the app (find, Harper, the
// reader, scroll sync) talks to, so it can be split but never closed. A split
// lays its children out in a row or a column, each with a share of the room.
//
// The tree functions are pure, so they are tested without a DOM; PaneGroup
// draws a tree and keeps each pane's content element alive across redraws.

import { icons } from "./icons";

export type Dir = "row" | "column";
export type Layout = { pane: number } | { dir: Dir; kids: Layout[]; sizes: number[] };
type Split = Extract<Layout, { dir: Dir }>;

/** More than this and a pane is too small to read in. */
export const MAX_PANES = 6;
const MIN_SHARE = 0.1;

export const single = (): Layout => ({ pane: 0 });
const isSplit = (l: Layout): l is Split => "dir" in l;

export function panes(l: Layout): number[] {
  return isSplit(l) ? l.kids.flatMap(panes) : [l.pane];
}

/** Shares that sum to 1, none below MIN_SHARE of an even share. */
function normal(sizes: number[]): number[] {
  const n = sizes.length;
  const floor = MIN_SHARE / n;
  const s = sizes.map((x) => (Number.isFinite(x) && x > 0 ? x : 1));
  const total = s.reduce((a, b) => a + b, 0);
  const fair = s.map((x) => Math.max(floor, x / total));
  const t2 = fair.reduce((a, b) => a + b, 0);
  return fair.map((x) => x / t2);
}

/**
 * Split pane `id` in direction `dir`, the new pane `fresh` going after it.
 * Inside a split already running that way the new pane becomes a sibling, so
 * three side by side are one row of three, not a row inside a row; it takes
 * half of the room `id` had.
 */
export function split(l: Layout, id: number, dir: Dir, fresh: number): Layout {
  if (!isSplit(l)) {
    return l.pane === id ? { dir, kids: [l, { pane: fresh }], sizes: [0.5, 0.5] } : l;
  }
  const i = l.kids.findIndex((k) => !isSplit(k) && k.pane === id);
  if (i >= 0 && l.dir === dir) {
    const kids = [...l.kids];
    const sizes = [...l.sizes];
    kids.splice(i + 1, 0, { pane: fresh });
    const half = sizes[i] / 2;
    sizes.splice(i, 1, half, half);
    return { dir, kids, sizes };
  }
  return { ...l, kids: l.kids.map((k) => split(k, id, dir, fresh)) };
}

/**
 * Take pane `id` out. Its room goes to its neighbour, a split left with one
 * child becomes that child, and a split inside one running the same way is
 * merged into it. Pane 0 stays.
 */
export function close(l: Layout, id: number): Layout {
  if (id === 0) return l;
  return tidy(remove(l, id) ?? single());
}

function remove(l: Layout, id: number): Layout | null {
  if (!isSplit(l)) return l.pane === id ? null : l;
  const kids: Layout[] = [];
  const sizes: number[] = [];
  // A removed child's room goes to the one before it, or after it if it was first.
  let orphan = 0;
  l.kids.forEach((k, n) => {
    const r = remove(k, id);
    if (r) { kids.push(r); sizes.push(l.sizes[n] + orphan); orphan = 0; }
    else if (sizes.length) sizes[sizes.length - 1] += l.sizes[n];
    else orphan += l.sizes[n];
  });
  if (kids.length === 0) return null;
  return { dir: l.dir, kids, sizes };
}

/** One-child splits collapse; a split in a split the same way merges. */
function tidy(l: Layout): Layout {
  if (!isSplit(l)) return l;
  const kids: Layout[] = [];
  const sizes: number[] = [];
  l.kids.forEach((k, n) => {
    const t = tidy(k);
    if (isSplit(t) && t.dir === l.dir) {
      t.kids.forEach((kk, m) => { kids.push(kk); sizes.push(l.sizes[n] * t.sizes[m]); });
    } else {
      kids.push(t);
      sizes.push(l.sizes[n]);
    }
  });
  if (kids.length === 1) return kids[0];
  return { dir: l.dir, kids, sizes: normal(sizes) };
}

/**
 * A layout read back from settings, which a person or an older build may
 * have written: anything malformed, a pane twice, too many panes, or no pane
 * 0, and it is the single pane.
 */
export function sanitize(raw: unknown): Layout {
  const seen = new Set<number>();
  const walk = (x: unknown, depth: number): Layout | null => {
    if (depth > 8 || typeof x !== "object" || x === null) return null;
    const o = x as Record<string, unknown>;
    if ("pane" in o) {
      const id = o.pane;
      if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || seen.has(id)) return null;
      seen.add(id);
      return { pane: id };
    }
    if ((o.dir !== "row" && o.dir !== "column") || !Array.isArray(o.kids) || o.kids.length < 2) return null;
    const kids: Layout[] = [];
    for (const k of o.kids) {
      const w = walk(k, depth + 1);
      if (!w) return null;
      kids.push(w);
    }
    const raw = Array.isArray(o.sizes) && o.sizes.length === kids.length ? o.sizes.map(Number) : kids.map(() => 1);
    return { dir: o.dir, kids, sizes: normal(raw) };
  };
  const l = walk(raw, 0);
  if (!l || !seen.has(0) || seen.size > MAX_PANES) return single();
  return tidy(l);
}

// ---------------------------------------------------------------- drawing

/** What a side puts in its panes. Pane 0's content is made by the app and given. */
export interface PaneContent {
  el: HTMLElement;
  /** The element that scrolls, so a redraw can put it back where it was. */
  scroller: HTMLElement;
  /** After a redraw, once the element is back in the page. */
  attached?(): void;
  destroy?(): void;
}

export interface PaneGroupHooks {
  /** A noun for tooltips: "editor", "preview". */
  name: string;
  create(id: number): PaneContent;
  /** A pane was split and this is the new one, in the page and in place. */
  opened?(id: number): void;
  /** The layout changed and is worth keeping. */
  changed(l: Layout): void;
}

export class PaneGroup {
  private layout: Layout = single();
  private content = new Map<number, PaneContent>();
  /** The pane last clicked or focused: where a keyboard split happens. */
  active = 0;

  constructor(readonly root: HTMLElement, primary: PaneContent, private hooks: PaneGroupHooks) {
    this.content.set(0, primary);
    const mark = (e: Event) => {
      const p = (e.target as HTMLElement).closest<HTMLElement>(".pane");
      if (p && this.root.contains(p)) this.active = Number(p.dataset.pane);
    };
    root.addEventListener("pointerdown", mark, true);
    root.addEventListener("focusin", mark);
    this.draw();
  }

  get current(): Layout { return this.layout; }
  get count(): number { return this.content.size; }

  /** Every pane's content but pane 0's, in no particular order. */
  extras(): PaneContent[] {
    return [...this.content].filter(([id]) => id !== 0).map(([, c]) => c);
  }

  /** Lay out `l`, making and dropping panes to match. Not reported as a change. */
  set(l: Layout) {
    this.layout = l;
    const want = new Set(panes(l));
    for (const [id, c] of this.content) {
      if (!want.has(id)) { c.destroy?.(); this.content.delete(id); }
    }
    for (const id of want) if (!this.content.has(id)) this.content.set(id, this.hooks.create(id));
    if (!want.has(this.active)) this.active = 0;
    this.draw();
  }

  split(id: number, dir: Dir): boolean {
    if (this.content.size >= MAX_PANES) return false;
    let fresh = 1;
    while (this.content.has(fresh)) fresh++;
    this.set(split(this.layout, id, dir, fresh));
    // The new pane opens where the one split was: two views of one place,
    // one of which then moves.
    const from = this.content.get(id)?.scroller;
    const to = this.content.get(fresh)!;
    if (from) to.scroller.scrollTop = from.scrollTop;
    this.active = fresh;
    this.hooks.opened?.(fresh);
    this.hooks.changed(this.layout);
    return true;
  }

  close(id: number) {
    if (id === 0 || !this.content.has(id)) return;
    this.set(close(this.layout, id));
    this.hooks.changed(this.layout);
  }

  /**
   * Build the tree afresh around the same content elements. Moving an element
   * loses its scroll position and focus, so both are noted first and put back.
   */
  private draw() {
    const tops = new Map<PaneContent, number>();
    for (const c of this.content.values()) tops.set(c, c.scroller.scrollTop);
    const focused = document.activeElement;

    this.root.replaceChildren(this.node(this.layout));

    for (const [c, top] of tops) {
      c.attached?.();
      c.scroller.scrollTop = top;
    }
    if (focused instanceof HTMLElement && this.root.contains(focused)) focused.focus({ preventScroll: true });
    this.root.dataset.panes = String(this.content.size);
  }

  private node(l: Layout): HTMLElement {
    if (!isSplit(l)) return this.leaf(l.pane);
    const box = document.createElement("div");
    box.className = "split";
    box.dataset.dir = l.dir;
    l.kids.forEach((k, n) => {
      if (n > 0) box.append(this.divider(l, n - 1, box));
      const el = this.node(k);
      el.style.flexGrow = String(l.sizes[n]);
      box.append(el);
    });
    return box;
  }

  private leaf(id: number): HTMLElement {
    const c = this.content.get(id)!;
    const pane = document.createElement("div");
    pane.className = "pane";
    pane.dataset.pane = String(id);
    const tools = document.createElement("div");
    tools.className = "pane-tools";
    const full = this.content.size >= MAX_PANES;
    const button = (icon: string, tip: string, run: () => void, disabled = false) => {
      const b = document.createElement("button");
      b.className = "icon small";
      b.innerHTML = icon;
      b.dataset.tip = tip;
      b.setAttribute("aria-label", tip);
      b.disabled = disabled;
      // Not on mousedown: a click here should not move focus out of the editor.
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.onclick = (e) => { e.stopPropagation(); run(); };
      tools.append(b);
    };
    const name = this.hooks.name;
    button(icons.splitRight, full ? `At most ${MAX_PANES} ${name} panes` : `Split ${name} right (Ctrl+\\)`, () => this.split(id, "row"), full);
    button(icons.splitDown, full ? `At most ${MAX_PANES} ${name} panes` : `Split ${name} down (Ctrl+Shift+\\)`, () => this.split(id, "column"), full);
    if (id !== 0) button(icons.close, `Close this ${name} pane`, () => this.close(id));
    pane.append(c.el, tools);
    return pane;
  }

  /** Drag to move the boundary between kids `i` and `i + 1`; double-click evens them. */
  private divider(l: Split, i: number, box: HTMLElement): HTMLElement {
    const div = document.createElement("div");
    div.className = "pane-divider";
    div.setAttribute("role", "separator");
    div.setAttribute("aria-orientation", l.dir === "row" ? "vertical" : "horizontal");
    const kid = (n: number) => box.children[n * 2] as HTMLElement;
    const paint = () => { kid(i).style.flexGrow = String(l.sizes[i]); kid(i + 1).style.flexGrow = String(l.sizes[i + 1]); };

    div.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      div.setPointerCapture(e.pointerId);
      document.body.classList.add("dragging");
      document.body.classList.toggle("dragging-rows", l.dir === "column");
      const row = l.dir === "row";
      const a = kid(i).getBoundingClientRect();
      const b = kid(i + 1).getBoundingClientRect();
      const start = row ? a.left : a.top;
      const span = Math.max(1, row ? b.right - a.left : b.bottom - a.top);
      const pair = l.sizes[i] + l.sizes[i + 1];
      const floor = (MIN_SHARE / l.sizes.length);
      const move = (ev: PointerEvent) => {
        const f = ((row ? ev.clientX : ev.clientY) - start) / span;
        const left = Math.min(pair - floor, Math.max(floor, f * pair));
        l.sizes[i] = left;
        l.sizes[i + 1] = pair - left;
        paint();
      };
      const up = () => {
        div.removeEventListener("pointermove", move);
        div.removeEventListener("pointerup", up);
        div.removeEventListener("pointercancel", up);
        document.body.classList.remove("dragging", "dragging-rows");
        for (const c of this.content.values()) c.attached?.();
        this.hooks.changed(this.layout);
      };
      div.addEventListener("pointermove", move);
      div.addEventListener("pointerup", up);
      div.addEventListener("pointercancel", up);
    });
    div.addEventListener("dblclick", () => {
      const pair = l.sizes[i] + l.sizes[i + 1];
      l.sizes[i] = l.sizes[i + 1] = pair / 2;
      paint();
      this.hooks.changed(this.layout);
    });
    return div;
  }
}
