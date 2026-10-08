// What a sentence should sound like: the rules file and the built-in clean-up.
//
// Text written to be read is not always text that can be heard. A voice says
// "open bracket", reads a URL letter by letter, and makes "SEC" a word. mk
// fixes the general cases itself (symbols, URLs, "e.g."). The rest depends on
// what is being read, so it lives beside the documents in a `.mk-speech.json`
// that mk finds in the document's folder or the nearest folder above:
//
//   {
//     "skip": { "sections": ["Links"], "startingWith": ["Sources:"], "code": true },
//     "abbreviations": ["v", "No", "Ltd"],
//     "words": { "SSNIT": "snit", "Ltd": "Limited" },
//     "spell": { "acronyms": true, "except": ["ECOWAS"] },
//     "replace": [
//       { "find": "\\bAct (\\d{3,4})\\b", "with": "Act ${digits:1}" },
//       { "find": "^0(\\d)\\. ", "with": "Topic $1. ", "in": "headings" }
//     ]
//   }
//
// The file is declarative on purpose: regular expressions and word lists, no
// code. A notes folder someone else wrote can change how its text is read, and
// nothing more. A bad rule is reported and skipped; the others still apply.
//
// Order of work on each sentence: the file's `replace` rules, its `words`, the
// built-ins, then acronyms are spelled, then the result is tidied.

export type Scope = "all" | "headings" | "text";

export interface RuleSpec {
  find: string;
  /** `$1`, `$&`, `$$`, and `${name:N}` to transform group N: digits, letters, upper, lower, roman, sub. */
  with?: string;
  flags?: string;
  /** Apply again until nothing changes: for chains such as `(2)(a)(i)`. */
  repeat?: boolean;
  in?: Scope;
  note?: string;
}

export interface RulesSpec {
  skip?: { sections?: string[]; startingWith?: string[]; code?: boolean };
  abbreviations?: string[];
  words?: Record<string, string>;
  spell?: { acronyms?: boolean; except?: string[] };
  replace?: RuleSpec[];
}

interface Compiled { re: RegExp; with: string; repeat: boolean; scope: Scope }

export interface Rules {
  /** Where the rules came from, for messages; null for the built-ins alone. */
  source: string | null;
  /** Lower-cased heading texts whose sections are not read. */
  skipSections: string[];
  /** A block whose text starts with one of these is not read. */
  skipStarting: string[];
  /** The file's say on code blocks; undefined leaves it to Settings. */
  skipCode: boolean | undefined;
  /** Words that end in a full stop without ending a sentence. */
  abbreviations: Set<string>;
  replace: Compiled[];
  words: { re: RegExp; say: string }[];
  spellAcronyms: boolean;
  spellExcept: Set<string>;
  /** One line per rule or field that could not be used. */
  errors: string[];
}

/** Abbreviations that end in a stop in ordinary English prose. */
export const COMMON_ABBREVIATIONS = [
  "Mr", "Mrs", "Ms", "Dr", "Prof", "Sr", "Jr", "St", "Mt", "vs", "v", "cf", "e.g", "i.e",
  "etc", "al", "approx", "Fig", "fig", "No", "no", "Vol", "vol", "pp", "p", "ch", "Ch",
  "Inc", "Ltd", "Co", "Corp", "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep",
  "Sept", "Oct", "Nov", "Dec",
];

export function noRules(): Rules {
  return {
    source: null, skipSections: [], skipStarting: [], skipCode: undefined,
    abbreviations: new Set(COMMON_ABBREVIATIONS), replace: [], words: [],
    spellAcronyms: false, spellExcept: new Set(), errors: [],
  };
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const escapeRegExp = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/** Read a rules file. Never throws: what cannot be used is listed in `errors`. */
export function parseRules(text: string, source: string | null = null): Rules {
  const r = noRules();
  r.source = source;
  let spec: RulesSpec;
  try {
    spec = JSON.parse(text) as RulesSpec;
  } catch (e) {
    r.errors.push(`not valid JSON: ${(e as Error).message}`);
    return r;
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    r.errors.push("the file should hold one JSON object");
    return r;
  }
  r.skipSections = strings(spec.skip?.sections).map((s) => s.trim().toLowerCase());
  r.skipStarting = strings(spec.skip?.startingWith);
  if (typeof spec.skip?.code === "boolean") r.skipCode = spec.skip.code;
  for (const a of strings(spec.abbreviations)) r.abbreviations.add(a.replace(/\.$/, ""));
  r.spellAcronyms = spec.spell?.acronyms === true;
  r.spellExcept = new Set(strings(spec.spell?.except));

  if (spec.words && typeof spec.words === "object") {
    for (const [word, say] of Object.entries(spec.words)) {
      if (typeof say !== "string" || !word) { r.errors.push(`words: "${word}" needs a string to say`); continue; }
      // Whole words, so "Co" does not touch "Court"; a key may end in a stop ("App.").
      r.words.push({ re: new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(word)}(?![\\p{L}\\p{N}_])`, "gu"), say });
    }
  }

  (Array.isArray(spec.replace) ? spec.replace : []).forEach((rule, n) => {
    const label = `replace[${n}]${rule?.note ? ` (${rule.note})` : ""}`;
    if (!rule || typeof rule.find !== "string") { r.errors.push(`${label}: "find" is missing`); return; }
    const flags = typeof rule.flags === "string" ? rule.flags : "g";
    try {
      // Always global and Unicode-aware: a rule is a substitution over the sentence.
      const f = [...new Set((flags + "gu").split(""))].join("");
      r.replace.push({
        re: new RegExp(rule.find, f),
        with: typeof rule.with === "string" ? rule.with : "",
        repeat: rule.repeat === true,
        scope: rule.in === "headings" || rule.in === "text" ? rule.in : "all",
      });
    } catch (e) {
      r.errors.push(`${label}: ${(e as Error).message}`);
    }
  });
  return r;
}

// ---------------------------------------------------------------- transforms

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };

/** A Roman numeral's value, or null if `s` is not one. */
export function romanValue(s: string): number | null {
  const t = s.toLowerCase();
  if (!/^[ivxlc]+$/.test(t)) return null;
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const v = ROMAN[t[i]], next = ROMAN[t[i + 1]] ?? 0;
    total += v < next ? -v : v;
  }
  return total > 0 ? total : null;
}

const TRANSFORMS: Record<string, (s: string) => string> = {
  /** "992" → "9 9 2": statute numbers are read digit by digit. */
  digits: (s) => s.replace(/\D/g, "").split("").join(" "),
  /** "L.I." or "LI" → "L I": spelled out. */
  letters: (s) => s.replace(/[^\p{L}\p{N}]/gu, "").split("").join(" "),
  upper: (s) => s.toUpperCase(),
  lower: (s) => s.toLowerCase(),
  roman: (s) => String(romanValue(s) ?? s),
  /**
   * A subsection: "2" stays, "a" becomes "A" (said "ay", not the article),
   * and a multi-letter Roman numeral such as "ii" becomes 2.
   */
  sub: (s) => /^\d/.test(s) ? s.replace(/^(\d+)([a-z])$/i, (_, d, l) => `${d} ${l.toUpperCase()}`)
    : s.length > 1 && romanValue(s) !== null ? String(romanValue(s)) : s.toUpperCase(),
};

/** Fill in a rule's `with` for one match. */
export function expand(template: string, match: string, groups: (string | undefined)[]): string {
  return template.replace(/\$\{(\w+):(\d{1,2})\}|\$(\d{1,2})|\$&|\$\$/g, (tok, fn, fnGroup, group) => {
    if (tok === "$$") return "$";
    if (tok === "$&") return match;
    if (fn !== undefined) {
      const value = groups[Number(fnGroup) - 1] ?? "";
      const f = TRANSFORMS[fn];
      return f ? f(value) : value;
    }
    return groups[Number(group) - 1] ?? "";
  });
}

function applyRule(text: string, rule: Compiled): string {
  const once = (t: string) => t.replace(rule.re, (m: string, ...rest: unknown[]) => {
    // The trailing arguments are offset, whole string and (maybe) named groups.
    const named = typeof rest[rest.length - 1] === "object" ? 1 : 0;
    const groups = rest.slice(0, rest.length - 2 - named) as (string | undefined)[];
    return expand(rule.with, m, groups);
  });
  if (!rule.repeat) return once(text);
  let prev = text;
  for (let i = 0; i < 20; i++) {
    const next = once(prev);
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}

// ---------------------------------------------------------------- built-ins

const BUILT_IN: [RegExp, string][] = [
  [/\bhttps?:\/\/\S+|\bwww\.\S+\.\S+/gu, ""],                  // a URL read aloud helps no one
  [/\be\.g\.,?/gu, "for example,"],
  [/\bi\.e\.,?/gu, "that is,"],
  [/\betc\.(?=\s*$)/gu, "and so on."],
  [/\betc\./gu, "and so on"],
  [/\bvs\.?(?=\s)/gu, "versus"],
  [/\s*[→⇒⟶]\s*/gu, ", then "],
  [/\s*←\s*/gu, " from "],
  [/\s*≤\s*/gu, " at most "],
  [/\s*≥\s*/gu, " at least "],
  [/\s*≠\s*/gu, " is not "],
  [/(\d)\s*×\s*(\d)/gu, "$1 times $2"],
  [/[~≈]\s*(?=\d)/gu, "about "],
  [/\s*[•·]\s*/gu, ", "],
  [/\s+&\s+/gu, " and "],
  [/US\$\s?(\d[\d,.]*)(?:\s?(m|bn|k)\b)?/gu, "$1 $2 US dollars"],
  [/\$\s?(\d[\d,.]*)(?:\s?(m|bn|k)\b)?/gu, "$1 $2 dollars"],
  [/£\s?(\d[\d,.]*)(?:\s?(m|bn|k)\b)?/gu, "$1 $2 pounds"],
  [/€\s?(\d[\d,.]*)(?:\s?(m|bn|k)\b)?/gu, "$1 $2 euros"],
  [/\s+[–—]\s+/gu, ", "],
  [/(?<=\p{L})\/(?=\p{L})/gu, " or "],                         // lender/borrower
  [/(?<=\p{L})\s+\/\s+(?=\p{L})/gu, " or "],                  // agreement / end
];
const SCALE: Record<string, string> = { m: "million", bn: "billion", k: "thousand" };

/** True when most words of a line are capitals: a heading set in caps, not prose with acronyms. */
export function shouting(text: string): boolean {
  const words = text.match(/\p{L}{2,}/gu) ?? [];
  const caps = words.filter((w) => w === w.toUpperCase() && w !== w.toLowerCase());
  return caps.length >= 2 && caps.length / words.length > 0.6;
}

function spellAcronyms(text: string, except: Set<string>): string {
  if (shouting(text)) return text;
  return text.replace(/(?<![\p{L}\p{N}])\p{Lu}{2,6}(?![\p{L}\p{N}])/gu, (w) =>
    except.has(w) || /^(X{0,3})(IX|IV|V?I{0,3})$/.test(w) ? w : w.split("").join(" "));
}

export function tidy(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\(\s*[,;:]?\s*\)/g, "")                // a bracket emptied by the rules
    .replace(/\(\s*[,;]\s*/g, "(")
    .replace(/\s*[,;]\s*\)/g, ")")
    .replace(/\s+([,.;:!?)])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/,(\s*,)+/g, ",")
    .replace(/([.!?])\s*[,;]/g, "$1")
    .replace(/,\s*\./g, ".")
    .replace(/\.{2,}(?!\.)/g, ".")
    .replace(/^[\s,;:]+/, "")
    .trim();
}

/** The words to send to the voice for one sentence of `kind`. Empty means skip it. */
export function speakable(text: string, rules: Rules, kind: "heading" | "text" = "text"): string {
  let t = text.normalize("NFC");
  const scope = kind === "heading" ? "headings" : "text";
  for (const rule of rules.replace) {
    if (rule.scope === "all" || rule.scope === scope) t = applyRule(t, rule);
  }
  for (const w of rules.words) t = t.replace(w.re, w.say);
  for (const [re, say] of BUILT_IN) {
    t = t.replace(re, (_m: string, ...rest: unknown[]) => {
      const groups = rest.slice(0, rest.length - 2) as (string | undefined)[];
      return say.replace(/\$(\d)/g, (_, n) => {
        const g = groups[Number(n) - 1] ?? "";
        return n === "2" && g ? SCALE[g] ?? g : g;
      }).replace(/\s{2,}/g, " ");
    });
  }
  if (rules.spellAcronyms) t = spellAcronyms(t, rules.spellExcept);
  return tidy(t);
}
