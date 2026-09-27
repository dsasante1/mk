// Pure helpers over text and paths. Nothing here touches the DOM or Tauri,
// which is what lets `text.test.ts` pin them down.

export type Eol = "\n" | "\r\n";

/**
 * The file's line ending, by majority. CodeMirror normalises everything to
 * `\n` in memory, so without remembering this a Windows file would silently
 * become a Unix one on its first save — a diff touching every line for an
 * edit to one.
 */
export function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

export function withEol(text: string, eol: Eol): string {
  return eol === "\n" ? text : text.replace(/\r?\n/g, "\r\n");
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;

/**
 * Words of prose. Fenced code is left out: a README's install block is not
 * something anyone reads at 230 words a minute, and counting it makes the
 * reading time a lie for exactly the documents that have one.
 */
export function countWords(md: string): number {
  let n = 0;
  let fence: string | null = null;
  for (const line of md.split("\n")) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (fence === null) { fence = m[1]; continue; }
      if (m[1][0] === fence[0] && m[1].length >= fence.length) { fence = null; continue; }
    }
    if (fence !== null) continue;
    n += (line.match(WORD) ?? []).length;
  }
  return n;
}

export function readingMinutes(words: number): number {
  return words === 0 ? 0 : Math.max(1, Math.round(words / 230));
}

const TASK = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\])/;

/**
 * The edit that flips a task checkbox on one line, or null if the line holds
 * no task. Returned as an offset into the line so the caller can make it a
 * single CodeMirror change — one undo step, not a rewrite of the line.
 */
export function toggleTask(line: string): { offset: number; insert: string } | null {
  const m = TASK.exec(line);
  if (!m) return null;
  return { offset: m[1].length, insert: m[2] === " " ? "x" : " " };
}

// ---- paths ----

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i < 0) return ".";
  return i === 0 ? path.slice(0, 1) : path.slice(0, i);
}

/** `~/…` for anything under the home directory, for the title bar. */
export function tildify(path: string, home: string | null): string {
  if (!home) return path;
  const sep = home.includes("\\") ? "\\" : "/";
  if (path === home || path.startsWith(home + sep)) return "~" + path.slice(home.length);
  return path;
}

/** A link target that leaves the document: a scheme, or protocol-relative. */
export function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

/**
 * Resolve a relative link from a document's folder. Percent-escapes are
 * decoded, since `my%20notes.md` names a file with a space in it, and
 * `?query` / `#fragment` are the caller's business, not part of the path.
 * `dir` is absolute: a document always has an absolute path by the time it
 * has links worth following. On Windows that is `C:\…` or `\\server\…`,
 * and the result keeps the drive and uses backslashes; a link written with
 * `/` resolves the same either way.
 */
export function resolvePath(dir: string, rel: string): string {
  let target = rel.replace(/[?#].*$/, "");
  try { target = decodeURIComponent(target); } catch { /* keep it raw */ }
  const win = /^[a-z]:[\\/]/i.exec(dir)?.[0].slice(0, 2) ?? (dir.startsWith("\\\\") ? "\\" : null);
  if (win === null) {
    const full = target.startsWith("/") ? target : `${dir}/${target}`;
    return "/" + normalise(full.split("/")).join("/");
  }
  // A drive-absolute target replaces `dir`; a rooted one (`/x`) keeps its drive.
  const drive = /^[a-z]:[\\/]/i.exec(target)?.[0].slice(0, 2);
  const root = drive ?? win;
  const rest = drive ? target.slice(2) : /^[\\/]/.test(target) ? target : `${dir.slice(win.length)}\\${target}`;
  return `${root}\\${normalise(rest.split(/[\\/]/)).join("\\")}`;
}

function normalise(segs: string[]): string[] {
  const parts: string[] = [];
  for (const seg of segs) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts;
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdown|mkd|mkdn|mdx)$/i.test(path.replace(/[?#].*$/, ""));
}

/** GitHub's heading anchor: lower-cased, punctuation dropped, spaces to dashes. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}
