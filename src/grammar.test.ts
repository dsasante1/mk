import { describe, expect, it } from "vitest";
import { ChangeSet } from "@codemirror/state";
import { groupOf, mapIssues, ruleLabel } from "./grammar";
import type { Issue } from "./api";

const issue = (from: number, to: number, fixes: Issue["fixes"] = []): Issue =>
  ({ from, to, rule: "SpellCheck", kind: "Spelling", message: "", text: "", fixes, hash: "1" });

describe("mapIssues", () => {
  it("moves issues after an edit and drops touched ones", () => {
    // "hello wrold and teh end": wrold 6–11, teh 16–19
    const issues = [issue(6, 11, [{ label: "", from: 6, to: 11, insert: "world" }]), issue(16, 19)];
    const insertAtStart = ChangeSet.of({ from: 0, insert: "Oh, " }, 23);
    const moved = mapIssues(issues, insertAtStart);
    expect(moved.map((i) => [i.from, i.to])).toEqual([[10, 15], [20, 23]]);
    expect(moved[0].fixes[0]).toMatchObject({ from: 10, to: 15 });

    const editInside = ChangeSet.of({ from: 7, to: 8, insert: "o" }, 23);
    expect(mapIssues(issues, editInside).map((i) => i.from)).toEqual([16]);
  });

  it("keeps insert-after fixes at the end of the issue", () => {
    const i = issue(4, 8, [{ label: "", from: 8, to: 8, insert: "," }]);
    const [m] = mapIssues([i], ChangeSet.of({ from: 0, insert: "xx" }, 20));
    expect(m.fixes[0]).toMatchObject({ from: 10, to: 10 });
  });
});

describe("labels", () => {
  it("groups kinds and splits rule names", () => {
    expect(groupOf("Typo")).toBe("spelling");
    expect(groupOf("Agreement")).toBe("grammar");
    expect(groupOf("SomethingNew")).toBe("style");
    expect(ruleLabel("PronounVerbAgreement")).toBe("Pronoun Verb Agreement");
    expect(ruleLabel("AnA")).toBe("An A");
  });
});
