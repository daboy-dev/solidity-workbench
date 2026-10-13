/**
 * Tolerant tokenizer for completion. It runs on text whose comments and
 * string contents were blanked (see `blankTrivia`), so it never sees them,
 * and it never fails: unknown characters become one-character punctuation.
 */

export type TokenKind = "ident" | "number" | "string" | "punct";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
  /** 0-based line of `start`. */
  readonly line: number;
}

const PUNCT = [">>>=", "<<=", ">>=", ">>>", "**", "=>", "==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=", "|=", "&=", "^=", "<<", ">>", "->", ":="];

export function tokenize(clean: string): Token[] {
  const out: Token[] = [];
  const n = clean.length;
  let i = 0;
  let line = 0;
  while (i < n) {
    const c = clean.charCodeAt(i);
    if (c === 0x0a) {
      line++;
      i++;
      continue;
    }
    if (c === 0x20 || c === 0x09 || c === 0x0d) {
      i++;
      continue;
    }
    const start = i;
    if (isIdentStart(c)) {
      while (i < n && isIdentPart(clean.charCodeAt(i))) i++;
      out.push({ kind: "ident", text: clean.slice(start, i), start, end: i, line });
      continue;
    }
    if (isDigit(c)) {
      i = scanNumber(clean, i);
      out.push({ kind: "number", text: clean.slice(start, i), start, end: i, line });
      continue;
    }
    if (c === 0x22 || c === 0x27) {
      // Contents are blank: the literal ends at the same quote or at the end of the line.
      i++;
      while (i < n && clean.charCodeAt(i) !== c && clean.charCodeAt(i) !== 0x0a) i++;
      if (i < n && clean.charCodeAt(i) === c) i++;
      out.push({ kind: "string", text: clean.slice(start, i), start, end: i, line });
      continue;
    }
    const op = PUNCT.find((p) => clean.startsWith(p, i)) ?? clean[i]!;
    i += op.length;
    out.push({ kind: "punct", text: op, start, end: i, line });
  }
  return out;
}

function scanNumber(s: string, i: number): number {
  const n = s.length;
  if (s[i] === "0" && (s[i + 1] === "x" || s[i + 1] === "X")) {
    i += 2;
    while (i < n && /[0-9a-fA-F_]/.test(s[i]!)) i++;
    return i;
  }
  while (i < n && /[0-9_]/.test(s[i]!)) i++;
  // `1.5`, but not `x[1].y` or a member access on a literal.
  if (s[i] === "." && /[0-9]/.test(s[i + 1] ?? "")) {
    i++;
    while (i < n && /[0-9_]/.test(s[i]!)) i++;
  }
  if ((s[i] === "e" || s[i] === "E") && /[-0-9]/.test(s[i + 1] ?? "")) {
    i += 2;
    while (i < n && /[0-9_]/.test(s[i]!)) i++;
  }
  return i;
}

function isIdentStart(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x24;
}

function isIdentPart(c: number): boolean {
  return isIdentStart(c) || isDigit(c);
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

const OPENERS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };

/**
 * Pairs of brackets, tolerant to half-written code. For an opener at index
 * `i`, `close[i]` is the index of its closer, or of the token where the group
 * was cut short (`closed[i]` false); `open[j]` is the reverse map for closers.
 * A declaration keyword (`function g`, `contract`, `event`...) closes the
 * parentheses and brackets left open before it, so that one unclosed `(`
 * does not swallow the rest of the file.
 */
export interface BracketPairs {
  readonly close: Int32Array;
  readonly closed: Uint8Array;
  readonly open: Int32Array;
}

const DECLARATION_KEYWORDS = new Set(["contract", "interface", "library", "abstract", "modifier", "event", "error", "struct", "enum", "constructor", "pragma", "import"]);

export function matchBrackets(tokens: readonly Token[]): BracketPairs {
  const n = tokens.length;
  const close = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const open = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  const cut = (at: number, keepBraces: boolean) => {
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      if (keepBraces && tokens[top]!.text === "{") break;
      stack.pop();
      close[top] = at;
    }
  };
  for (let i = 0; i < n; i++) {
    const t = tokens[i]!;
    if (t.kind === "ident") {
      const declaration =
        DECLARATION_KEYWORDS.has(t.text) || (t.text === "function" && tokens[i + 1]?.kind === "ident" && tokens[i + 1]?.text !== "returns");
      if (declaration) cut(i, true);
      continue;
    }
    if (t.kind !== "punct") continue;
    if (OPENERS[t.text]) {
      stack.push(i);
      continue;
    }
    if (t.text !== ")" && t.text !== "]" && t.text !== "}") continue;
    const at = findLast(stack, (k) => OPENERS[tokens[k]!.text] === t.text);
    if (at < 0) continue; // Stray closer.
    while (stack.length > at + 1) close[stack.pop()!] = i;
    const k = stack.pop()!;
    close[k] = i;
    closed[k] = 1;
    open[i] = k;
  }
  for (const k of stack) close[k] = n;
  return { close, closed, open };
}

function findLast(stack: readonly number[], f: (k: number) => boolean): number {
  for (let i = stack.length - 1; i >= 0; i--) if (f(stack[i]!)) return i;
  return -1;
}
