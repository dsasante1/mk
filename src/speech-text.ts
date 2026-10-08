// Splitting a block's text into the sentences read aloud, one at a time.
//
// Sentences are the unit of everything the reader does: what is highlighted,
// what [ and ] step over, what is synthesised ahead. `Intl.Segmenter` finds the
// candidates, but it ends a sentence at every abbreviation ("Mr. ", "v. ",
// "P.S. "), so its pieces are joined back where a stop did not end one:
// after a known abbreviation or an initial, before a lower-case word or a
// digit, and inside unclosed brackets, where notes keep references whose
// stops end nothing.

export interface Piece {
  /** Offsets into the block's text, trimmed of surrounding space. */
  from: number;
  to: number;
}

const segmenter: Intl.Segmenter | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("en", { granularity: "sentence" }) : null;

/** Candidate boundaries: after sentence punctuation (and closing quotes or brackets) and a space. */
function candidates(text: string): number[] {
  if (segmenter) return [...segmenter.segment(text)].map((s) => s.index).filter((i) => i > 0);
  const out: number[] = [];
  for (const m of text.matchAll(/[.!?…]+["'”’)\]]*\s+/g)) out.push(m.index + m[0].length);
  return out;
}

/** The word just before the final stop of `piece`, without the stop: "Mr", "e.g", "P.S". */
function lastWord(piece: string): string {
  const m = /(\S+?)\.["'”’)]*\s*$/.exec(piece);
  return m ? m[1].replace(/^[("'“‘[]+/, "") : "";
}

function depth(text: string, open: string, close: string): number {
  let d = 0;
  for (const c of text) {
    if (c === open) d++;
    else if (c === close && d > 0) d--;
  }
  return d;
}

/** Whether the stop at the end of `head` ends the sentence, given what follows. */
function ends(head: string, rest: string, abbreviations: Set<string>): boolean {
  // A list label on its own ("14.", "b.", "iv.") belongs to what follows it.
  if (/^\s*(?:\d{1,3}|[a-z]|[ivx]{1,4})\.\s*$/i.test(head)) return false;
  const word = lastWord(head);
  if (word) {
    if (abbreviations.has(word)) return false;
    if (/^(\p{Lu}\.)*\p{Lu}$/u.test(word)) return false;           // an initial: "P.S.", "L.C.B."
  }
  const next = rest.trimStart();
  if (!next) return true;
  if (/^[\p{Ll}\d]/u.test(next)) return false;                      // "… s. 29", "… e.g. the"
  if (depth(head, "[", "]") > 0 || depth(head, "(", ")") > 0) return false;
  return true;
}

/** Past this many characters a sentence is read in parts, split at its semicolons. */
export const LONG = 200;
/** A part is at least this long, so a split does not leave a scrap. */
const PART = 60;

/** The sentences of `text`, as trimmed offset ranges. */
export function sentences(text: string, abbreviations: Set<string>): Piece[] {
  const cuts = candidates(text);
  const out: Piece[] = [];
  let start = 0;
  for (const cut of cuts) {
    if (!ends(text.slice(start, cut), text.slice(cut), abbreviations)) continue;
    push(out, text, start, cut);
    start = cut;
  }
  push(out, text, start, text.length);
  return out.flatMap((p) => (p.to - p.from > LONG ? parts(text, p) : [p]));
}

/**
 * A long sentence split at semicolons outside brackets. Notes string clauses
 * together with them; read whole, such a sentence keeps the listener waiting
 * while it is synthesised and keeps one highlight on screen for half a minute.
 */
function parts(text: string, p: Piece): Piece[] {
  const out: Piece[] = [];
  let start = p.from;
  let square = 0, round = 0;
  for (let i = p.from; i < p.to; i++) {
    const c = text[i];
    if (c === "[") square++;
    else if (c === "]" && square) square--;
    else if (c === "(") round++;
    else if (c === ")" && round) round--;
    else if (c === ";" && !square && !round && i + 1 - start >= PART && p.to - (i + 1) >= PART) {
      push(out, text, start, i + 1);
      start = i + 1;
    }
  }
  push(out, text, start, p.to);
  return out;
}

function push(out: Piece[], text: string, from: number, to: number) {
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  if (to > from) out.push({ from, to });
}

/** Where a reading should pick up: `index` if its text still matches, else the nearest sentence with that text. */
export function relocate(texts: string[], index: number, text: string): number {
  if (texts[index] === text) return index;
  for (let d = 1; d < texts.length; d++) {
    if (texts[index - d] === text) return index - d;
    if (texts[index + d] === text) return index + d;
  }
  return Math.min(Math.max(0, index), Math.max(0, texts.length - 1));
}
