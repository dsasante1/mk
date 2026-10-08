import { describe, expect, it } from "vitest";
import { expand, noRules, parseRules, romanValue, shouting, speakable, tidy } from "./speech-rules";
import { relocate, sentences } from "./speech-text";

const split = (text: string, extra: string[] = []) => {
  const r = noRules();
  for (const a of extra) r.abbreviations.add(a);
  return sentences(text, r.abbreviations).map((p) => text.slice(p.from, p.to));
};

describe("sentences", () => {
  it("splits on full stops and trims", () => {
    expect(split("  One. Two!  Three?  ")).toEqual(["One.", "Two!", "Three?"]);
  });

  it("keeps abbreviations and initials inside a sentence", () => {
    expect(split("Mr. Mensah v. Mensah held so. Next.")).toEqual(["Mr. Mensah v. Mensah held so.", "Next."]);
    expect(split("P.S. Investment Ltd won. L.C.B. Gower wrote.")).toEqual(["P.S. Investment Ltd won.", "L.C.B. Gower wrote."]);
  });

  it("does not end before a lower-case word or a number", () => {
    expect(split("See s. 29 and e.g. the Act. Then stop.")).toEqual(["See s. 29 and e.g. the Act.", "Then stop."]);
  });

  it("does not end inside brackets", () => {
    expect(split("Held [see Adadzi (2021), p. 12. Also ch. 3] for now. Next.", ["p"]))
      .toEqual(["Held [see Adadzi (2021), p. 12. Also ch. 3] for now.", "Next."]);
  });

  it("keeps a numbered label with its text", () => {
    expect(split("14. Corporate insolvency. Next.")).toEqual(["14. Corporate insolvency.", "Next."]);
    expect(split("Held in 2012. The end.")).toEqual(["Held in 2012.", "The end."]);
  });

  it("reads a long sentence in parts at its semicolons, not inside brackets", () => {
    const clause = (n: number) => `clause ${n} runs on for a while with enough words to matter`;
    const long = `${clause(1)}; ${clause(2)} (see a; b); ${clause(3)}; ${clause(4)}.`;
    const got = split(long);
    expect(got.length).toBeGreaterThan(1);
    expect(got.join(" ")).toBe(long);
    expect(got.every((p) => !p.endsWith("(see a;"))).toBe(true);
    expect(got.every((p) => p.length >= 60)).toBe(true);
    expect(split("Short; very short.")).toEqual(["Short; very short."]);
  });

  it("takes extra abbreviations from the rules", () => {
    expect(split("Apply Comm. Court rules. Done.")).toEqual(["Apply Comm.", "Court rules.", "Done."]);
    expect(split("Apply Comm. Court rules. Done.", ["Comm"])).toEqual(["Apply Comm. Court rules.", "Done."]);
  });

  it("finds a moved sentence again", () => {
    expect(relocate(["a", "b", "c"], 1, "b")).toBe(1);
    expect(relocate(["x", "a", "b", "c"], 1, "b")).toBe(2);
    expect(relocate(["a"], 5, "gone")).toBe(0);
  });
});

describe("built-in clean-up", () => {
  const say = (t: string) => speakable(t, noRules());

  it("drops URLs and expands common abbreviations", () => {
    expect(say("See https://example.com/x for more, e.g. the guide.")).toBe("See for more, for example, the guide.");
    expect(say("Pens, paper, etc.")).toBe("Pens, paper, and so on.");
  });

  it("reads symbols", () => {
    expect(say("draft → review → sign")).toBe("draft, then review, then sign");
    expect(say("≤ 12 months, ≥ 3 members")).toBe("at most 12 months, at least 3 members");
    expect(say("US$500,000 and £2m")).toBe("500,000 US dollars and 2 million pounds");
    expect(say("lender/borrower")).toBe("lender or borrower");
    expect(say("agreement / end administration")).toBe("agreement or end administration");
  });

  it("tidies what rules leave behind", () => {
    expect(tidy("Held ( ; ) , so  .")).toBe("Held, so.");
    expect(tidy("a ,b")).toBe("a,b");
  });

  it("leaves acronyms alone unless asked", () => {
    expect(say("The SEC rules")).toBe("The SEC rules");
  });
});

describe("rules file", () => {
  it("reports problems without failing", () => {
    expect(parseRules("{ nope").errors[0]).toMatch(/not valid JSON/);
    const r = parseRules(JSON.stringify({ replace: [{ find: "(" }, { with: "x" }, { find: "a", with: "b" }] }));
    expect(r.errors).toHaveLength(2);
    expect(r.replace).toHaveLength(1);
  });

  it("applies replacements, words and acronym spelling in that order", () => {
    const r = parseRules(JSON.stringify({
      replace: [{ find: "\\[✓[^\\]]*\\]", with: "" }, { find: "\\[verify\\]", with: "(unconfirmed)" }],
      words: { SSNIT: "snit", Ltd: "Limited" },
      spell: { acronyms: true, except: ["ECOWAS"] },
    }));
    expect(speakable("Register with SSNIT and the SEC [✓ Act 992 s 13].", r)).toBe("Register with snit and the S E C.");
    expect(speakable("Mensah Ltd joined ECOWAS [verify].", r)).toBe("Mensah Limited joined ECOWAS (unconfirmed).");
  });

  it("does not spell headings set in capitals", () => {
    const r = parseRules(JSON.stringify({ spell: { acronyms: true } }));
    expect(shouting("WRITTEN RESOLUTION OF THE BOARD")).toBe(true);
    expect(speakable("WRITTEN RESOLUTION OF THE BOARD", r)).toBe("WRITTEN RESOLUTION OF THE BOARD");
    expect(speakable("Part IV of the Act", r)).toBe("Part IV of the Act");
  });

  it("scopes rules to headings or text", () => {
    const r = parseRules(JSON.stringify({ replace: [{ find: "^0(\\d)\\. ", with: "Topic $1. ", in: "headings" }] }));
    expect(speakable("07. Corporate Governance", r, "heading")).toBe("Topic 7. Corporate Governance");
    expect(speakable("07. Corporate Governance", r, "text")).toBe("07. Corporate Governance");
  });

  it("skips what it is told to", () => {
    const r = parseRules(JSON.stringify({ skip: { sections: ["Links "], startingWith: ["Sources:"], code: false } }));
    expect(r.skipSections).toEqual(["links"]);
    expect(r.skipStarting).toEqual(["Sources:"]);
    expect(r.skipCode).toBe(false);
  });
});

describe("transforms", () => {
  it("expands groups and transforms", () => {
    expect(expand("Act ${digits:1}", "Act 992", ["992"])).toBe("Act 9 9 2");
    expect(expand("${letters:1} $2", "L.I. 2473", ["L.I.", "2473"])).toBe("L I 2473");
    expect(expand("$$1 $& $1", "x", ["y"])).toBe("$1 x y");
    expect(expand("${sub:1}|${sub:2}|${sub:3}|${sub:4}", "", ["2", "a", "ii", "1A"])).toBe("2|A|2|1 A");
  });

  it("reads Roman numerals", () => {
    expect(romanValue("iv")).toBe(4);
    expect(romanValue("XIX")).toBe(19);
    expect(romanValue("abc")).toBeNull();
  });

  it("repeats a rule until it settles, for chained subsections", () => {
    const r = parseRules(JSON.stringify({
      replace: [
        { find: "(?<![\\w'’])ss?\\.?\\s+(?=\\d)", with: "section " },
        { find: "(?<=\\([a-z]\\))\\((i{1,3}|iv|vi{0,3}|ix|x)\\)", with: " ${roman:1}" },
        { find: "(?<=[\\dA-Z)])\\(([0-9]{1,3}[A-Z]?|[a-z]{1,4})\\)", with: " ${sub:1}", repeat: true },
      ],
    }));
    expect(speakable("Under s 189(1)(a)(i) and s 275(2)(a).", r)).toBe("Under section 189 1 A 1 and section 275 2 A.");
    expect(speakable("the company's 274 shares", r)).toBe("the company's 274 shares");
  });
});
