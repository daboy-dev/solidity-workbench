/**
 * Minimal Solidity lexer for trivia: finds comments and string literals.
 * It never fails, so it can be used on half-written code.
 */

export type TriviaKind = "lineComment" | "blockComment" | "string";

export interface TriviaRange {
  readonly kind: TriviaKind;
  readonly start: number;
  /** Exclusive. For unterminated tokens this is the end of the text (or line, for strings). */
  readonly end: number;
  /** False for an unterminated block comment or string; the cursor at `end` is then still inside. */
  readonly terminated: boolean;
  /** The quote character used, for strings. */
  readonly quote?: '"' | "'";
}

export function scanTrivia(text: string): TriviaRange[] {
  const out: TriviaRange[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 0x2f /* / */ && i + 1 < n) {
      const d = text.charCodeAt(i + 1);
      if (d === 0x2f /* / */) {
        let j = i + 2;
        while (j < n && text.charCodeAt(j) !== 0x0a) j++;
        out.push({ kind: "lineComment", start: i, end: j, terminated: false });
        i = j;
        continue;
      }
      if (d === 0x2a /* * */) {
        const close = text.indexOf("*/", i + 2);
        const end = close < 0 ? n : close + 2;
        out.push({ kind: "blockComment", start: i, end, terminated: close >= 0 });
        i = end;
        continue;
      }
    }
    if (c === 0x22 /* " */ || c === 0x27 /* ' */) {
      let j = i + 1;
      let terminated = false;
      while (j < n) {
        const e = text.charCodeAt(j);
        if (e === 0x5c /* \ */) {
          j += 2;
          continue;
        }
        if (e === 0x0a) break;
        if (e === c) {
          terminated = true;
          j++;
          break;
        }
        j++;
      }
      // An unterminated string stops at the newline and lexing continues.
      out.push({ kind: "string", start: i, end: Math.min(j, n), terminated, quote: c === 0x22 ? '"' : "'" });
      i = Math.min(j, n);
      continue;
    }
    i++;
  }
  return out;
}

/**
 * True when `offset` (a cursor position) is inside a comment or string.
 * A cursor right after the closing quote/`*\/` is outside; inside an
 * unterminated line comment or string up to the end of line it is inside.
 */
export function isInCommentOrString(trivia: readonly TriviaRange[], offset: number): boolean {
  // Binary search for the last range starting before offset.
  let lo = 0;
  let hi = trivia.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (trivia[mid]!.start < offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return false;
  const r = trivia[found]!;
  if (offset < r.end) return true;
  // Line comments and unterminated tokens include their end position;
  // a cursor right after a closing quote or `*/` is outside.
  return offset === r.end && !r.terminated;
}

/**
 * Returns the text with comments and string contents replaced by spaces
 * (newlines preserved), so offsets and line numbers stay valid. String
 * quotes are kept so that `import "x"` still looks like a string.
 */
export function blankTrivia(text: string, trivia: readonly TriviaRange[] = scanTrivia(text)): string {
  if (trivia.length === 0) return text;
  let out = "";
  let last = 0;
  for (const r of trivia) {
    out += text.slice(last, r.start);
    const chunk = text.slice(r.start, r.end);
    if (r.kind === "string") {
      out += r.terminated ? chunk[0] + blank(chunk.slice(1, -1)) + chunk.slice(-1) : chunk[0] + blank(chunk.slice(1));
    } else {
      out += blank(chunk);
    }
    last = r.end;
  }
  return out + text.slice(last);
}

function blank(s: string): string {
  return s.replace(/[^\n]/g, " ");
}
