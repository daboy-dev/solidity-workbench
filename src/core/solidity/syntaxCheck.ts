import { computeLineStarts, lineOf } from "./extractSymbols";

/** A syntax problem in offsets (UTF-16) of the analysed text. */
export interface SyntaxProblem {
  readonly start: number;
  readonly end: number;
  readonly message: string;
  readonly code: SyntaxProblemCode;
  /** Replacement text for the range, when a quick fix is obvious (keyword typos). */
  readonly fix?: string;
}

export type SyntaxProblemCode = "unclosed-bracket" | "unexpected-bracket" | "mismatched-bracket" | "keyword-typo" | "trailing-comma" | "parser";

const OPENERS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
const CLOSERS: Record<string, string> = { "}": "{", ")": "(", "]": "[" };

interface Opener {
  readonly char: string;
  readonly offset: number;
  readonly label: string;
  /** Indentation of the line where the block header starts. */
  readonly indent: number;
}

/**
 * Checks bracket balance on comment- and string-free text. For a `}` that is
 * less indented than the block it would close, the indentation is used to
 * find the block that was really left open, which is what people expect when
 * they forget a brace in the middle of a file.
 */
export function checkBrackets(clean: string): SyntaxProblem[] {
  const problems: SyntaxProblem[] = [];
  const lineStarts = computeLineStarts(clean);
  const lineNo = (offset: number) => lineOf(lineStarts, offset) + 1;
  const stack: Opener[] = [];

  const unclosed = (o: Opener) =>
    problems.push({
      start: o.offset,
      end: o.offset + 1,
      code: "unclosed-bracket",
      message: `Missing \`${OPENERS[o.char]}\` to close ${o.label} (opened on line ${lineNo(o.offset)}).`,
    });

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (c in OPENERS) {
      const headerStart = c === "{" ? blockHeaderStart(clean, i) : i;
      stack.push({ char: c, offset: i, label: labelFor(clean, c, headerStart, i), indent: indentOf(clean, lineStarts, headerStart) });
      continue;
    }
    const expected = CLOSERS[c];
    if (!expected) continue;

    if (c === "}" && isFirstOnLine(clean, lineStarts, i)) {
      // Forgotten `}`: this one is aligned with an outer block, not with the innermost.
      const indent = indentOf(clean, lineStarts, i);
      const top = stack.at(-1);
      if (top && top.char === "{" && indent < top.indent) {
        const match = findLastIndex(stack, (o) => o.char === "{" && o.indent === indent);
        if (match >= 0) {
          for (const o of stack.splice(match + 1)) unclosed(o);
          stack.pop();
          continue;
        }
      }
    }

    const top = stack.at(-1);
    if (!top) {
      problems.push({ start: i, end: i + 1, code: "unexpected-bracket", message: `Unexpected \`${c}\`: there is nothing to close.` });
      continue;
    }
    if (top.char === expected) {
      stack.pop();
      continue;
    }
    // e.g. `foo(a, b}`: the inner `(` was never closed. Close it and retry with the outer opener.
    const outer = findLastIndex(stack, (o) => o.char === expected);
    if (outer >= 0) {
      for (const o of stack.splice(outer + 1)) {
        problems.push({
          start: o.offset,
          end: o.offset + 1,
          code: "mismatched-bracket",
          message: `Missing \`${OPENERS[o.char]}\` to close ${o.label} before \`${c}\` on line ${lineNo(i)}.`,
        });
      }
      stack.pop();
    } else {
      problems.push({ start: i, end: i + 1, code: "unexpected-bracket", message: `Unexpected \`${c}\`: there is no \`${expected}\` to close.` });
    }
  }
  for (const o of stack.reverse()) unclosed(o);
  return problems.sort((a, b) => a.start - b.start);
}

/** Words before `(` that open a parenthesized expression or tuple, where `(a, )` may be valid. */
const NOT_A_LIST = new Set(["return", "if", "while", "for", "else", "do", "emit", "revert", "delete", "new"]);

/**
 * Trailing commas, which Solidity never accepts in argument and parameter lists, struct
 * literals, enums, import lists and array literals: `S({a: 1,})`, `f(a, b,)`. Tuples may
 * have empty components (`(bool ok, ) = x.call("")`), so a `(` that does not follow a
 * name, a call or an index is left alone. Runs on comment- and string-free text.
 */
export function checkTrailingCommas(clean: string): SyntaxProblem[] {
  const problems: SyntaxProblem[] = [];
  const stack: Array<{ char: string; list: boolean }> = [];
  let lastComma = -1;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (/\s/.test(c)) continue;
    if (c === "(" || c === "[" || c === "{") {
      stack.push({ char: c, list: c !== "(" || isListParen(clean, i) });
    } else if (c === ")" || c === "]" || c === "}") {
      const open = stack.pop();
      if (lastComma >= 0 && open?.list) {
        problems.push({ start: lastComma, end: lastComma + 1, code: "trailing-comma", message: `Trailing comma before \`${c}\` is not allowed.`, fix: "" });
      }
    }
    lastComma = c === "," ? i : -1;
  }
  return problems;
}

/** True when the `(` at `i` opens a call's arguments or a parameter list. */
function isListParen(clean: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(clean[j]!)) j--;
  const prev = clean[j];
  if (prev === ")" || prev === "]" || prev === "}") return true;
  if (prev === undefined || !/[\w$]/.test(prev)) return false;
  let k = j;
  while (k >= 0 && /[\w$]/.test(clean[k]!)) k--;
  return !NOT_A_LIST.has(clean.slice(k + 1, j + 1));
}

const NAMED_BLOCK = /^(abstract\s+contract|contract|interface|library|struct|enum|function|modifier)\s+([A-Za-z_$][\w$]*)/;
const UNNAMED_BLOCK = /^(constructor|fallback|receive|unchecked|assembly|else\s+if|else|if|for|while|do|try|catch)\b/;

/** Human name of what a bracket opens: "`contract Vault`", "the `if` block", "`(`". */
function labelFor(clean: string, char: string, headerStart: number, offset: number): string {
  if (char !== "{") return `\`${char}\``;
  const header = clean.slice(headerStart, offset).replace(/\s+/g, " ").trim();
  const named = NAMED_BLOCK.exec(header);
  if (named) return `\`${named[1]} ${named[2]}\``;
  const unnamed = UNNAMED_BLOCK.exec(header);
  return unnamed ? `the \`${unnamed[1]}\` block` : "this block";
}

/** Start of the statement or declaration that a `{` belongs to. */
function blockHeaderStart(clean: string, brace: number): number {
  let depth = 0;
  let i = brace - 1;
  for (; i >= 0; i--) {
    const c = clean[i]!;
    if (c === ")" || c === "]") depth++;
    else if (c === "(" || c === "[") depth--;
    else if (depth <= 0 && (c === ";" || c === "{" || c === "}")) break;
  }
  i++;
  while (i < brace && /\s/.test(clean[i]!)) i++;
  return i;
}

function indentOf(text: string, lineStarts: readonly number[], offset: number): number {
  const start = lineStarts[lineOf(lineStarts, offset)]!;
  let i = start;
  let width = 0;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) {
    width += text[i] === "\t" ? 4 : 1;
    i++;
  }
  return width;
}

function isFirstOnLine(text: string, lineStarts: readonly number[], offset: number): boolean {
  return /^[ \t]*$/.test(text.slice(lineStarts[lineOf(lineStarts, offset)]!, offset));
}

function findLastIndex<T>(list: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (predicate(list[i]!)) return i;
  return -1;
}

// --- Keyword typos ---------------------------------------------------------

const TOP_LEVEL_KEYWORDS = ["contract", "interface", "library", "struct", "enum", "function", "event", "error", "abstract"];
const MEMBER_KEYWORDS = ["function", "modifier", "constructor", "fallback", "receive", "event", "error", "struct", "enum"];

/** Words that may legitimately start a declaration. Never reported as typos. */
const RESERVED = new Set([
  ...TOP_LEVEL_KEYWORDS,
  ...MEMBER_KEYWORDS,
  "pragma", "import", "using", "type", "mapping", "address", "bool", "string", "bytes", "uint", "int", "fixed", "ufixed",
  "payable", "public", "private", "internal", "external", "constant", "immutable", "override", "virtual", "transient",
  "return", "returns", "emit", "if", "else", "for", "while", "do", "try", "catch", "revert", "assembly", "unchecked", "delete", "new",
]);

const IDENT = /[A-Za-z_$][\w$]*/y;

interface Scope {
  readonly kind: "top" | "contract" | "other";
}

/**
 * Finds misspelled declaration keywords (`contact Vault {`, `fucntion f(`,
 * `constuctor(`). Only shapes that can never be valid Solidity are checked:
 * at file level `word Name {` or `word Name (`; inside a contract
 * `word Name (`, `word Name {` or `word (`. A user-defined type followed by a
 * name and `;` or `=` (a variable) is never reported.
 */
export function checkKeywordTypos(clean: string): SyntaxProblem[] {
  const problems: SyntaxProblem[] = [];
  const scopes: Scope[] = [{ kind: "top" }];
  let statementStart = true;

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (c === "{") {
      const header = clean.slice(blockHeaderStart(clean, i), i);
      scopes.push({ kind: /^\s*(abstract\s+contract|contract|interface|library)\b/.test(header) ? "contract" : "other" });
      statementStart = true;
      continue;
    }
    if (c === "}") {
      if (scopes.length > 1) scopes.pop();
      statementStart = true;
      continue;
    }
    if (c === ";") {
      statementStart = true;
      continue;
    }
    if (/\s/.test(c)) continue;
    if (!statementStart) continue;
    statementStart = false;

    const scope = scopes.at(-1)!.kind;
    if (scope === "other") continue;
    IDENT.lastIndex = i;
    const word = IDENT.exec(clean)?.[0];
    if (!word) continue;
    const end = i + word.length;
    i = end - 1;
    if (RESERVED.has(word) || /^u?int\d+$|^bytes\d+$/.test(word)) continue;

    const shape = shapeAfter(clean, end);
    const candidates =
      scope === "top"
        ? shape === "name{" || shape === "name("
          ? TOP_LEVEL_KEYWORDS
          : shape === "contract"
            ? ["abstract"]
            : []
        : shape === "name(" || shape === "name{"
          ? MEMBER_KEYWORDS
          : shape === "("
            ? ["constructor", "fallback", "receive", "modifier"]
            : [];
    const suggestion = closestKeyword(word, candidates);
    if (suggestion) {
      problems.push({
        start: i + 1 - word.length,
        end,
        code: "keyword-typo",
        message: `Unknown keyword \`${word}\`. Did you mean \`${suggestion}\`?`,
        fix: suggestion,
      });
    }
  }
  return problems;
}

type Shape = "name{" | "name(" | "contract" | "(" | "other";

function shapeAfter(clean: string, offset: number): Shape {
  const rest = clean.slice(offset, offset + 200);
  if (/^\s*\(/.test(rest)) return "(";
  const m = /^\s+([A-Za-z_$][\w$]*)\s*([({])?/.exec(rest);
  if (!m) return "other";
  if (m[1] === "contract") return "contract";
  if (m[2] === "{") return "name{";
  if (m[2] === "(") return "name(";
  // `contact Vault is Base {`
  if (/^\s+[A-Za-z_$][\w$]*\s+is\b/.test(rest)) return "name{";
  return "other";
}

function closestKeyword(word: string, keywords: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const k of keywords) {
    const max = k.length <= 4 ? 1 : 2;
    const d = damerauLevenshtein(word.toLowerCase(), k);
    if (d <= max && d < bestDistance) {
      best = k;
      bestDistance = d;
    }
  }
  return best;
}

/** Edit distance counting adjacent transpositions as one edit (`fucntion` → `function`). */
export function damerauLevenshtein(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

// --- Parser error messages ----------------------------------------------------

/** Rewrites an ANTLR message from @solidity-parser/parser into something readable. */
export function describeParserError(message: string): string {
  const token = (t: string) => (t === "<EOF>" ? "end of file" : `\`${t}\``);
  const expecting = (set: string | undefined): string => {
    if (!set) return "";
    const items = set
      .replace(/^\{|\}$/g, "")
      .split(/,\s*/)
      .map((s) => s.trim().replace(/^'(.*)'$/, "$1"))
      .filter(Boolean);
    if (items.length === 0 || items.length > 3) return "";
    return ` Expected ${items.map((s) => (s === "<EOF>" ? "end of file" : `\`${s}\``)).join(" or ")}.`;
  };
  let m = /^missing '?(.+?)'? at '(.*)'$/.exec(message);
  if (m) return `Missing \`${m[1]}\` before ${token(m[2]!)}.`;
  m = /^(?:extraneous|mismatched) input '(.*)' expecting (.*)$/s.exec(message);
  if (m) return m[1] === "<EOF>" ? `Unexpected end of file.${expecting(m[2])}` : `Unexpected ${token(m[1]!)}.${expecting(m[2])}`;
  m = /^no viable alternative at input '(.*)'$/s.exec(message);
  if (m) return `Syntax error near \`${m[1]!.split(/\s+/).at(-1)}\`.`;
  m = /^token recognition error at: '(.*)'$/.exec(message);
  if (m) return `Invalid character \`${m[1]}\`.`;
  return message;
}
