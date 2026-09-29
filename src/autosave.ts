// Auto save. Each document is written a moment after its last edit, one
// write at a time, and an edit made while a write is out is written after it
// rather than lost or taken for saved.
//
// This module only decides when. Whether a document may be written at all is
// `blocked`, and the write itself is the app's, so that auto save goes through
// the same atomic, line-ending-keeping path as Ctrl+S.

export interface AutoSaveHooks<T> {
  enabled(): boolean;
  /** Write `t` if it may be written. Reporting a failure is the hook's job. */
  write(t: T): Promise<void>;
}

export class AutoSave<T> {
  private timers = new Map<T, ReturnType<typeof setTimeout>>();
  private inflight = new Map<T, Promise<void>>();
  private again = new Set<T>();

  constructor(private hooks: AutoSaveHooks<T>, private delay = 1000) {}

  /** After an edit: write `t` once edits have paused for `delay`. */
  schedule(t: T) {
    if (!this.hooks.enabled()) return;
    this.clear(t);
    this.timers.set(t, setTimeout(() => void this.run(t), this.delay));
  }

  /** Forget `t`: it has closed. A write already out finishes on its own. */
  cancel(t: T) {
    this.clear(t);
    this.again.delete(t);
  }

  /** Write `t` now rather than after the pause, and wait for it. */
  async flush(t: T) {
    this.clear(t);
    await this.inflight.get(t);
    await this.run(t);
  }

  /** Flush every document with a write pending. */
  async flushAll() {
    await Promise.all([...this.timers.keys()].map((t) => this.flush(t)));
  }

  private clear(t: T) {
    clearTimeout(this.timers.get(t));
    this.timers.delete(t);
  }

  private run(t: T): Promise<void> {
    this.timers.delete(t);
    if (!this.hooks.enabled()) return Promise.resolve();
    const busy = this.inflight.get(t);
    if (busy) { this.again.add(t); return busy; }
    const p = this.hooks.write(t).catch(() => {}).then(() => {
      this.inflight.delete(t);
      if (this.again.delete(t)) return this.run(t);
    });
    this.inflight.set(t, p);
    return p;
  }
}

export interface Saveable {
  path: string | null;
  /** The file's mtime when last read or written; null for a file not yet created. */
  mtime: number | null;
}

/**
 * Why `t` may not be auto saved now, or null if it may. `disk` is the file's
 * mtime as it stands. A file changed (or removed) since mk last saw it is left
 * alone: overwriting it would lose somebody's work, and the change-on-disk
 * banner is where that gets decided.
 */
export function blocked(t: Saveable, dirty: boolean, disk: number | null): "untitled" | "clean" | "changed" | null {
  if (!t.path) return "untitled";
  if (!dirty) return "clean";
  if (disk !== t.mtime) return "changed";
  return null;
}
