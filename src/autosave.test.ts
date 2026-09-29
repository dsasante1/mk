import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoSave, blocked } from "./autosave";

interface Doc { text: string; saved: string }

/** An AutoSave over plain objects, whose writes finish when `finish()` is called. */
function rig(opts: { enabled?: () => boolean; fail?: () => boolean } = {}) {
  const writes: string[] = [];
  const waiting: (() => void)[] = [];
  const auto = new AutoSave<Doc>({
    enabled: opts.enabled ?? (() => true),
    write(d) {
      const snapshot = d.text;
      writes.push(snapshot);
      return new Promise<void>((resolve) => {
        waiting.push(() => {
          if (!opts.fail?.()) d.saved = snapshot;
          resolve();
        });
      });
    },
  }, 1000);
  const finish = async () => {
    waiting.splice(0).forEach((f) => f());
    await vi.advanceTimersByTimeAsync(0);
  };
  return { auto, writes, finish };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("auto save", () => {
  it("writes once edits pause, not on every edit", async () => {
    const { auto, writes } = rig();
    const d = { text: "a", saved: "" };
    auto.schedule(d);
    await vi.advanceTimersByTimeAsync(600);
    d.text = "ab";
    auto.schedule(d);
    await vi.advanceTimersByTimeAsync(600);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    expect(writes).toEqual(["ab"]);
  });

  it("writes an edit made during a write after it, not instead of it", async () => {
    const { auto, writes, finish } = rig();
    const d = { text: "one", saved: "" };
    auto.schedule(d);
    await vi.advanceTimersByTimeAsync(1000);
    d.text = "two";
    auto.schedule(d);
    await vi.advanceTimersByTimeAsync(1000);
    // The first write is still out, so the second waits for it.
    expect(writes).toEqual(["one"]);
    await finish();
    expect(d.saved).toBe("one");
    expect(writes).toEqual(["one", "two"]);
    await finish();
    expect(d.saved).toBe("two");
  });

  it("does nothing while switched off, even with a write pending", async () => {
    let on = true;
    const { auto, writes } = rig({ enabled: () => on });
    const d = { text: "a", saved: "" };
    auto.schedule(d);
    on = false;
    await vi.advanceTimersByTimeAsync(5000);
    auto.schedule(d);
    await auto.flush(d);
    expect(writes).toEqual([]);
  });

  it("forgets a closed document", async () => {
    const { auto, writes } = rig();
    const d = { text: "a", saved: "" };
    auto.schedule(d);
    auto.cancel(d);
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes).toEqual([]);
  });

  it("flush writes now and waits for a write already out", async () => {
    const { auto, writes, finish } = rig();
    const d = { text: "one", saved: "" };
    auto.schedule(d);
    await vi.advanceTimersByTimeAsync(1000);
    d.text = "two";
    let done = false;
    const flushed = auto.flush(d).then(() => { done = true; });
    await finish();
    expect(writes).toEqual(["one", "two"]);
    expect(done).toBe(false);
    await finish();
    await flushed;
    expect(d.saved).toBe("two");
  });

  it("flushAll writes every pending document at once", async () => {
    const { auto, writes, finish } = rig();
    const a = { text: "a", saved: "" };
    const b = { text: "b", saved: "" };
    auto.schedule(a);
    auto.schedule(b);
    const all = auto.flushAll();
    await vi.advanceTimersByTimeAsync(0);
    await finish();
    await all;
    expect(writes.sort()).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes).toHaveLength(2);
  });

  it("a failed write does not retry by itself, and the next edit tries again", async () => {
    let fail = true;
    const { auto, writes, finish } = rig({ fail: () => fail });
    const d = { text: "a", saved: "" };
    auto.schedule(d);
    await vi.advanceTimersByTimeAsync(1000);
    await finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toEqual(["a"]);
    expect(d.saved).toBe("");
    fail = false;
    d.text = "ab";
    auto.schedule(d);
    await vi.advanceTimersByTimeAsync(1000);
    await finish();
    expect(d.saved).toBe("ab");
  });

  it("a write hook that throws does not wedge the document", async () => {
    let calls = 0;
    const auto = new AutoSave<object>({
      enabled: () => true,
      write: async () => { calls++; throw new Error("disk full"); },
    }, 1000);
    const d = {};
    await auto.flush(d);
    await auto.flush(d);
    expect(calls).toBe(2);
  });
});

describe("what may be auto saved", () => {
  it("never an untitled document, which would need a dialog", () => {
    expect(blocked({ path: null, mtime: null }, true, null)).toBe("untitled");
  });

  it("nothing that is already saved", () => {
    expect(blocked({ path: "/a.md", mtime: 5 }, false, 5)).toBe("clean");
  });

  it("never over a change on disk mk has not seen", () => {
    expect(blocked({ path: "/a.md", mtime: 5 }, true, 6)).toBe("changed");
    // Deleted or moved away since it was opened.
    expect(blocked({ path: "/a.md", mtime: 5 }, true, null)).toBe("changed");
    // Opened as a new file, and something else has since created it.
    expect(blocked({ path: "/a.md", mtime: null }, true, 7)).toBe("changed");
  });

  it("a dirty file that is as mk left it, including one not created yet", () => {
    expect(blocked({ path: "/a.md", mtime: 5 }, true, 5)).toBeNull();
    expect(blocked({ path: "/new.md", mtime: null }, true, null)).toBeNull();
  });
});
