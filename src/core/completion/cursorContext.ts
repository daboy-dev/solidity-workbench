import { isInCommentOrString } from "../solidity/lexContext";
import {
  DATA_LOCATIONS,
  parseType,
  typeText,
  type Callable,
  type CallableKind,
  type Container,
  type ContractNode,
  type Decl,
  type SourceStructure,
  type StatementSpan,
} from "./structure";
import type { Token } from "./tokens";

/** An expression whose type completion needs, as written before a `.` or around the cursor. */
export type Expr =
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "member"; readonly object: Expr; readonly name: string }
  | { readonly kind: "call"; readonly callee: Expr; readonly args: CallArgs }
  | { readonly kind: "index"; readonly object: Expr }
  /** `type(X)`. */
  | { readonly kind: "typeOf"; readonly type: string }
  /** `new C` (called or not). */
  | { readonly kind: "new"; readonly type: string }
  | { readonly kind: "literal"; readonly type: "string" | "number" | "bool" };

/**
 * The arguments of a call: each one parsed when it is a postfix expression (`a.b(c)[d]`, a
 * literal), undefined otherwise (`a + b`, half-written). `names` for `f({a: x, b: y})`.
 */
export interface CallArgs {
  readonly values: readonly (Expr | undefined)[];
  readonly names?: readonly string[];
}

/** What the value being typed is expected to match, to rank compatible suggestions first. */
export type Expected =
  | { readonly kind: "type"; readonly type: string; readonly name?: string }
  | { readonly kind: "sameAs"; readonly expr: Expr }
  | { readonly kind: "namedArg"; readonly callee: Expr; readonly name: string }
  /** `before`: the arguments given before this one. */
  | { readonly kind: "arg"; readonly callee: Expr; readonly index: number; readonly before: readonly (Expr | undefined)[] }
  | { readonly kind: "return" };

export type Site =
  /** Nothing to suggest: comments, strings, imports, assembly, names being declared. */
  | { readonly kind: "none" }
  /** `keyword`: after `emit X.` or `revert X.`, where only events or errors fit. */
  | { readonly kind: "member"; readonly receiver: Expr; readonly keyword?: "emit" | "revert" }
  /** After a number literal: `1 ether`. */
  | { readonly kind: "unit" }
  | { readonly kind: "fileLevel" }
  | { readonly kind: "contractLevel" }
  | { readonly kind: "structField" }
  | { readonly kind: "statement" }
  | { readonly kind: "expression"; readonly expected?: Expected; readonly keyword?: "emit" | "revert" }
  /** Only a type fits: parameters, `new`, `using ... for`, `is`, mapping keys and values. */
  | { readonly kind: "typeName"; readonly purpose: "param" | "new" | "using" | "inheritance" | "mapping" | "udvt" | "override" }
  /** After a type: data locations, `indexed`, state variable attributes, `payable`... */
  | { readonly kind: "afterType"; readonly type: string; readonly where: "local" | "param" | "eventParam" | "state" | "file"; readonly used: readonly string[] }
  | { readonly kind: "functionAttributes"; readonly callable: CallableKind; readonly used: readonly string[] }
  /** Left of `:` in `S({ a: 1, | })`. */
  | { readonly kind: "namedArgName"; readonly callee: Expr; readonly given: readonly string[] }
  /** Left of `:` in `x.call{ | }(...)`. */
  | { readonly kind: "callOption"; readonly given: readonly string[] }
  /** Right after `abstract`. */
  | { readonly kind: "afterAbstract" };

export interface CursorContext {
  readonly structure: SourceStructure;
  readonly offset: number;
  /** Start of the identifier being typed (the cursor when there is none). */
  readonly prefixStart: number;
  readonly prefix: string;
  readonly site: Site;
  readonly contract: ContractNode | undefined;
  readonly callable: Callable | undefined;
  /** Parameters and local variables visible at the cursor, innermost first, shadowed names removed. */
  readonly locals: readonly Decl[];
}

const NONE: Site = { kind: "none" };
const CALLABLE_KEYWORDS = new Set(["function", "modifier", "constructor", "fallback", "receive"]);
const KEYWORDS_EXPECTING_MORE = new Set(["return", "emit", "new", "delete", "is", "returns", "revert", "using", "for", "else", "constant", "immutable", "override", "public", "private", "internal", "external", "memory", "storage", "calldata", "view", "pure", "payable", "virtual"]);
const ASSIGNMENTS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "|=", "&=", "^=", "<<=", ">>=", ">>>="]);
const COMPARISONS = new Set(["==", "!=", "<", ">", "<=", ">="]);
/** Words before `(` that are not callees. */
const NOT_CALLEES = new Set(["if", "while", "for", "return", "emit", "returns", "catch", "require", "assert", "revert"]);

export function cursorContext(structure: SourceStructure, offset: number): CursorContext {
  const { tokens, text } = structure;
  let before = countBefore(tokens, offset);
  let prefixStart = offset;
  const last = tokens[before - 1];
  if (last && last.end >= offset && (last.kind === "ident" || last.kind === "number")) {
    before--;
    prefixStart = last.start;
  }
  const prefix = text.slice(prefixStart, offset);
  const base = { structure, offset, prefixStart, prefix };
  const contract = innermost(structure.contracts, offset);
  const callable = innermost(structure.callables, offset);
  const span = statementAt(structure, before, offset);
  const locals = visibleLocals(structure, callable, prefixStart, span);
  const make = (site: Site): CursorContext => ({ ...base, site, contract, callable, locals });

  if (last?.kind === "number" && last.end >= offset) return make(NONE);
  if (isInCommentOrString(structure.trivia, offset)) return make(NONE);
  if (structure.silent.some(([s, e]) => offset > s && offset <= e)) return make(NONE);

  const prev = tokens[before - 1];
  if (prev?.text === ".") {
    const receiver = parseBackward(structure, before - 2);
    if (!receiver || receiver.expr.kind === "literal") return make(NONE);
    const keyword = tokens[receiver.first - 1]?.text;
    return make({ kind: "member", receiver: receiver.expr, ...(keyword === "emit" || keyword === "revert" ? { keyword } : {}) });
  }
  if (prev?.kind === "number" && !prev.text.startsWith("0x") && prev.line === lineOf(text, tokens, offset, before)) return make({ kind: "unit" });

  const container = innermostContainer(structure.containers, offset);
  if (container?.kind === "assembly" || container?.kind === "enum") return make(NONE);
  const where = span?.container ?? containerKind(container);
  const first = span ? span.first : before;
  return make(classify(structure, where, first, before));
}

// ---- locating the cursor -------------------------------------------------------

function countBefore(tokens: readonly Token[], offset: number): number {
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid]!.start < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lineOf(text: string, tokens: readonly Token[], offset: number, before: number): number {
  const prev = tokens[before - 1];
  if (!prev) return 0;
  return text.slice(prev.end, offset).includes("\n") ? prev.line + 1 : prev.line;
}

function innermost<T extends { start: number; end: number }>(items: readonly T[], offset: number): T | undefined {
  let best: T | undefined;
  for (const it of items) if (offset > it.start && offset <= it.end && (!best || it.start >= best.start)) best = it;
  return best;
}

function innermostContainer(containers: readonly Container[], offset: number): Container | undefined {
  let best: Container | undefined;
  for (const c of containers) if (offset >= c.start && offset <= c.end && (!best || c.start >= best.start)) best = c;
  return best;
}

function containerKind(c: Container | undefined): StatementSpan["container"] {
  if (!c) return "file";
  return c.kind === "assembly" ? "body" : c.kind;
}

/** The statement the cursor is in, if it has started (tokens before the cursor) and is not finished. */
function statementAt(structure: SourceStructure, before: number, offset: number): StatementSpan | undefined {
  const { tokens, text } = structure;
  const container = innermostContainer(structure.containers, offset);
  let best: StatementSpan | undefined;
  for (const s of structure.statements) {
    if (s.first >= before || (best && s.first <= best.first)) continue;
    if (container && s.start < container.start) continue;
    let inside = before < s.last;
    // A header ended by the `{` of its body (not part of the span) still holds a cursor before the `{`.
    if (!inside && before === s.last && s.terminated) inside = tokens[s.last - 1]!.text !== ";";
    else if (!inside && before === s.last) {
      const lastTok = tokens[s.last - 1]!;
      const sameLine = !text.slice(lastTok.end, offset).includes("\n");
      const expectsMore = (lastTok.kind === "punct" && !")]};".includes(lastTok.text)) || KEYWORDS_EXPECTING_MORE.has(lastTok.text);
      inside = sameLine || expectsMore || (s.container !== "body" && CALLABLE_KEYWORDS.has(tokens[s.first]!.text));
    }
    if (inside) best = s;
  }
  return best;
}

function visibleLocals(structure: SourceStructure, callable: Callable | undefined, at: number, span: StatementSpan | undefined): Decl[] {
  const out: Decl[] = [];
  const own = (d: Decl) => span !== undefined && d.nameStart >= span.start && d.nameStart <= Math.max(span.end, at);
  for (const scope of structure.scopes) {
    if (at < scope.start || at > scope.end) continue;
    for (const d of scope.decls) if (d.visibleFrom <= at && !own(d)) out.push(d);
  }
  out.sort((a, b) => b.nameStart - a.nameStart);
  if (callable) out.push(...callable.returns.filter((d) => d.name), ...callable.params.filter((d) => d.name));
  const seen = new Set<string>();
  return out.filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true)));
}

// ---- classification ------------------------------------------------------------

interface Group {
  readonly open: number;
  readonly kind: "(" | "[" | "{";
}

/** Brackets opened within tokens [first, before) and still open at the cursor, outermost first. */
function openGroups(structure: SourceStructure, first: number, before: number): Group[] {
  const { tokens, pairs } = structure;
  const out: Group[] = [];
  let k = first;
  while (k < before) {
    const t = tokens[k]!.text;
    if (t === "(" || t === "[" || t === "{") {
      const close = pairs.close[k]!;
      if (close >= before) {
        out.push({ open: k, kind: t });
        k++;
        continue;
      }
      k = close + 1;
      continue;
    }
    k++;
  }
  return out;
}

/** Splits tokens [from, to) at top-level commas; returns the start of the last segment. */
function lastSegmentStart(structure: SourceStructure, from: number, to: number, separators: ReadonlySet<string> = new Set([","])): number {
  const { tokens, pairs } = structure;
  let start = from;
  let k = from;
  while (k < to) {
    const t = tokens[k]!.text;
    if (t === "(" || t === "[" || t === "{") {
      const close = pairs.close[k]!;
      if (close >= to) return start; // An open group: the caller handles it.
      k = close + 1;
      continue;
    }
    if (separators.has(t)) start = k + 1;
    k++;
  }
  return start;
}

function classify(structure: SourceStructure, where: StatementSpan["container"], first: number, before: number): Site {
  const { tokens } = structure;
  if (first >= before) {
    switch (where) {
      case "file":
        return { kind: "fileLevel" };
      case "contract":
        return { kind: "contractLevel" };
      case "struct":
        return { kind: "structField" };
      case "enum":
        return NONE;
      case "body":
        return { kind: "statement" };
    }
  }
  const head = tokens[first]!.text;
  if (where === "body") return bodyStatement(structure, first, before);
  if (where === "struct") return afterTypeOrNone(structure, first, before, "local", true);
  if (where === "enum") return NONE;
  if (CALLABLE_KEYWORDS.has(head) && !(head === "function" && tokens[first + 1]?.text === "(")) return callableHeader(structure, first, before);
  if (head === "event" || head === "error") {
    const groups = openGroups(structure, first, before);
    const g = groups[0];
    if (!g || g.kind !== "(") return NONE;
    return paramSite(structure, g.open + 1, before, head === "event" ? "eventParam" : "param");
  }
  if (head === "abstract" && before === first + 1) return { kind: "afterAbstract" };
  if (head === "contract" || head === "interface" || head === "library" || head === "abstract") {
    const isAt = findTop(structure, first, before, "is");
    if (isAt < 0) return NONE;
    const groups = openGroups(structure, isAt, before);
    if (groups.length) return expressionIn(structure, groups, before);
    const segment = lastSegmentStart(structure, isAt + 1, before);
    return segment === before ? { kind: "typeName", purpose: "inheritance" } : NONE;
  }
  if (head === "struct" || head === "enum" || head === "pragma" || head === "import") return NONE;
  if (head === "using") return findTop(structure, first, before, "for") >= 0 ? { kind: "typeName", purpose: "using" } : before === first + 1 ? { kind: "typeName", purpose: "using" } : NONE;
  if (head === "type") return findTop(structure, first, before, "is") === before - 1 ? { kind: "typeName", purpose: "udvt" } : NONE;
  return stateVariable(structure, first, before, where === "file" ? "file" : "state");
}

function findTop(structure: SourceStructure, from: number, to: number, text: string): number {
  const { tokens, pairs } = structure;
  let found = -1;
  for (let k = from; k < to; k++) {
    const t = tokens[k]!.text;
    if (t === text) found = k;
    if ((t === "(" || t === "[" || t === "{") && pairs.close[k]! < to) k = pairs.close[k]!;
  }
  return found;
}

function callableHeader(structure: SourceStructure, first: number, before: number): Site {
  const { tokens } = structure;
  const kind = tokens[first]!.text as CallableKind;
  const groups = openGroups(structure, first, before);
  // The parameter list is the first `(` after the keyword (and the name, for functions and modifiers).
  const paramsOpen = tokens[first + 1]?.text === "(" ? first + 1 : tokens[first + 2]?.text === "(" ? first + 2 : -1;
  const g = groups[0];
  if (g) {
    const isParams = g.open === paramsOpen || tokens[g.open - 1]?.text === "returns";
    if (isParams && groups.length === 1) return paramSite(structure, g.open + 1, before, "param");
    if (isParams) return typeNameOrExpression(structure, groups, before);
    if (tokens[g.open - 1]?.text === "override") return { kind: "typeName", purpose: "override" };
    // Modifier or base constructor arguments.
    return expressionIn(structure, groups, before);
  }
  if (paramsOpen < 0 || before <= paramsOpen) return NONE; // Naming the function.
  const used: string[] = [];
  const paramsClose = structure.pairs.close[paramsOpen]!;
  for (let k = paramsClose + 1; k < before; k++) if (tokens[k]!.kind === "ident") used.push(tokens[k]!.text);
  return { kind: "functionAttributes", callable: kind, used };
}

/** In a parameter list, at the segment starting at the last top-level comma. */
function paramSite(structure: SourceStructure, from: number, before: number, where: "param" | "eventParam"): Site {
  const segment = lastSegmentStart(structure, from, before);
  if (segment >= before) return { kind: "typeName", purpose: "param" };
  return afterTypeOrNone(structure, segment, before, where, false);
}

/** `Type |` → attributes after a type; `Type name |` and anything else → nothing. */
function afterTypeOrNone(structure: SourceStructure, first: number, before: number, where: "local" | "param" | "eventParam", struct: boolean): Site {
  const { tokens } = structure;
  const groups = openGroups(structure, first, before);
  if (groups.length) return typeNameOrExpression(structure, groups, before);
  const typeEnd = parseTypeAt(structure, first, before);
  if (typeEnd < 0) return NONE;
  if (typeEnd === before) return struct ? { kind: "afterType", type: typeText(tokens, first, typeEnd), where: "local", used: ["memory", "storage", "calldata"] } : { kind: "afterType", type: typeText(tokens, first, typeEnd), where, used: [] };
  const used = tokens.slice(typeEnd, before).map((t) => t.text);
  const onlyAttributes = used.every((u) => DATA_LOCATIONS.has(u) || u === "indexed");
  return onlyAttributes ? { kind: "afterType", type: typeText(tokens, first, typeEnd), where, used } : NONE;
}

/** Inside `mapping(` the key and value are types; elsewhere an open group holds an expression. */
function typeNameOrExpression(structure: SourceStructure, groups: readonly Group[], before: number): Site {
  const inner = groups.at(-1)!;
  if (inner.kind === "(" && structure.tokens[inner.open - 1]?.text === "mapping") {
    const segment = lastSegmentStart(structure, inner.open + 1, before, new Set(["=>"]));
    return segment === before ? { kind: "typeName", purpose: "mapping" } : NONE;
  }
  return expressionIn(structure, groups, before);
}

function stateVariable(structure: SourceStructure, first: number, before: number, where: "state" | "file"): Site {
  const { tokens } = structure;
  const assign = findTop(structure, first, before, "=");
  if (assign >= 0) {
    const groups = openGroups(structure, assign + 1, before);
    if (groups.length) return expressionIn(structure, groups, before);
    const typeEnd = parseTypeAt(structure, first, assign);
    const nameTok = tokens[assign - 1];
    const expected: Expected | undefined = typeEnd > first ? { kind: "type", type: typeText(tokens, first, typeEnd), ...(nameTok ? { name: nameTok.text } : {}) } : undefined;
    return expressionTail(structure, assign + 1, before, expected);
  }
  const groups = openGroups(structure, first, before);
  if (groups.length) return typeNameOrExpression(structure, groups, before);
  const typeEnd = parseTypeAt(structure, first, before);
  if (typeEnd < 0) return NONE;
  const rest = tokens.slice(typeEnd, before).map((t) => t.text);
  const attributes = new Set(["public", "private", "internal", "constant", "immutable", "override", "transient"]);
  if (rest.every((r) => attributes.has(r))) return { kind: "afterType", type: typeText(tokens, first, typeEnd), where, used: rest };
  return NONE;
}

function bodyStatement(structure: SourceStructure, first: number, before: number): Site {
  const { tokens } = structure;
  const head = tokens[first]!.text;
  const groups = openGroups(structure, first, before);
  if (groups.length) {
    const outer = groups[0]!;
    // `for (uint256 i = 0; ...`: the init clause is a statement of its own.
    if (head === "for" && outer.open === first + 1 && groups.length === 1) {
      const semi = findTop(structure, outer.open + 1, before, ";");
      if (semi < 0) return before === outer.open + 1 ? { kind: "statement" } : bodyStatement(structure, outer.open + 1, before);
      return expressionTail(structure, semi + 1, before, undefined);
    }
    // `try f() returns (uint256 x)`, `catch Error(string memory reason)`.
    if (groups.length === 1 && (tokens[outer.open - 1]?.text === "returns" || head === "catch")) return paramSite(structure, outer.open + 1, before, "param");
    // `(uint256 a, bool b) = f();`
    if (outer.open === first && groups.length === 1 && outer.kind === "(") {
      const segment = lastSegmentStart(structure, first + 1, before);
      if (segment === before) return { kind: "expression" };
      const site = afterTypeOrNone(structure, segment, before, "local", false);
      if (site.kind === "afterType") return site;
    }
    return expressionIn(structure, groups, before);
  }
  if (head === "emit" && before === first + 1) return { kind: "expression", keyword: "emit" };
  if (head === "revert" && before === first + 1) return { kind: "expression", keyword: "revert" };
  if (head === "return") return expressionTail(structure, first + 1, before, { kind: "return" });
  if (head === "new" && before === first + 1) return { kind: "typeName", purpose: "new" };
  // A declaration: `Type |`, `Type memory |`, `Type name = |`.
  const typeEnd = parseTypeAt(structure, first, before);
  if (typeEnd === before) return { kind: "afterType", type: typeText(tokens, first, typeEnd), where: "local", used: [] };
  if (typeEnd > first) {
    let j = typeEnd;
    if (DATA_LOCATIONS.has(tokens[j]!.text)) j++;
    if (j === before) return NONE; // Naming the variable.
    if (tokens[j]?.kind === "ident" && tokens[j + 1]?.text === "=" && j + 1 < before) {
      return expressionTail(structure, j + 2, before, { kind: "type", type: typeText(tokens, first, typeEnd), name: tokens[j]!.text });
    }
  }
  return expressionTail(structure, first, before, undefined);
}

/** Inside open groups: named arguments, call options, call arguments, indexes. */
function expressionIn(structure: SourceStructure, groups: readonly Group[], before: number): Site {
  const { tokens } = structure;
  const g = groups.at(-1)!;
  const prev = tokens[g.open - 1];
  if (g.kind === "{") {
    const named = prev?.text === "(";
    const option = !named && prev !== undefined && (prev.kind === "ident" || prev.text === ")" || prev.text === "]");
    if (!named && !option) return expressionTail(structure, lastSegmentStart(structure, g.open + 1, before), before, undefined);
    const segment = lastSegmentStart(structure, g.open + 1, before);
    const given = namedArgsGiven(structure, g.open);
    const colon = findTop(structure, segment, before, ":");
    if (colon < 0) {
      if (segment < before) return NONE;
      if (option) return { kind: "callOption", given };
      const callee = parseBackward(structure, g.open - 2);
      return callee ? { kind: "namedArgName", callee: callee.expr, given } : NONE;
    }
    const name = tokens[colon - 1]?.text ?? "";
    if (option) return expressionTail(structure, colon + 1, before, { kind: "type", type: name === "salt" ? "bytes32" : "uint256" });
    const callee = parseBackward(structure, g.open - 2);
    return expressionTail(structure, colon + 1, before, callee ? { kind: "namedArg", callee: callee.expr, name } : undefined);
  }
  const segment = lastSegmentStart(structure, g.open + 1, before);
  if (g.kind === "[") return expressionTail(structure, segment, before, undefined);
  if (prev?.text === "type") return { kind: "typeName", purpose: "new" };
  if (prev?.text === "if" || prev?.text === "while" || ((prev?.text === "require" || prev?.text === "assert") && segment === g.open + 1)) {
    return expressionTail(structure, segment, before, { kind: "type", type: "bool" });
  }
  if (prev && !NOT_CALLEES.has(prev.text) && (prev.kind === "ident" || prev.text === ")" || prev.text === "]" || prev.text === "}")) {
    const callee = parseBackward(structure, g.open - 1);
    // The arguments before the one at the cursor (`segment` starts after their last comma).
    const given = segment > g.open + 1 ? segments(structure, g.open + 1, segment - 1).map(([s, e]) => exprIn(structure, s, e)) : [];
    return expressionTail(structure, segment, before, callee ? { kind: "arg", callee: callee.expr, index: given.length, before: given } : undefined);
  }
  return expressionTail(structure, segment, before, undefined);
}

/** The arguments of the call whose `(` is token `open` (closed or not). */
export function callArgs(structure: SourceStructure, open: number): CallArgs {
  const { tokens, pairs } = structure;
  const c = pairs.close[open]!;
  const close = c > open ? Math.min(c, tokens.length) : tokens.length;
  const brace = pairs.close[open + 1]!;
  if (tokens[open + 1]?.text === "{" && brace === close - 1) {
    // Named arguments: `name: value` segments inside the braces.
    const values: (Expr | undefined)[] = [];
    const names: string[] = [];
    for (const [s, e] of segments(structure, open + 2, brace)) {
      if (tokens[s]?.kind !== "ident" || tokens[s + 1]?.text !== ":") continue;
      names.push(tokens[s]!.text);
      values.push(exprIn(structure, s + 2, e));
    }
    return { values, names };
  }
  return { values: segments(structure, open + 1, close).map(([s, e]) => exprIn(structure, s, e)) };
}

/** Top-level comma-separated segments of tokens [from, to), as [start, end) pairs; none when empty. */
function segments(structure: SourceStructure, from: number, to: number): Array<[number, number]> {
  const { tokens, pairs } = structure;
  if (from >= to) return [];
  const out: Array<[number, number]> = [];
  let start = from;
  for (let k = from; k < to; k++) {
    const t = tokens[k]!.text;
    if (t === ",") {
      out.push([start, k]);
      start = k + 1;
    } else if (t === "(" || t === "[" || t === "{") {
      const c = pairs.close[k]!;
      if (c <= k || c >= to) break;
      k = c;
    }
  }
  out.push([start, to]);
  return out;
}

/** The expression spanning exactly tokens [from, to), when it is a postfix expression. */
function exprIn(structure: SourceStructure, from: number, to: number): Expr | undefined {
  if (from >= to) return undefined;
  const parsed = parseBackward(structure, to - 1);
  return parsed && parsed.first === from ? parsed.expr : undefined;
}

/** Names already given in the named-argument block opened at `open` (before and after the cursor). */
function namedArgsGiven(structure: SourceStructure, open: number): string[] {
  const { tokens, pairs } = structure;
  const close = Math.min(pairs.close[open]!, tokens.length);
  const out: string[] = [];
  let segmentStart = true;
  for (let k = open + 1; k < close; k++) {
    const t = tokens[k]!;
    if (segmentStart && t.kind === "ident" && tokens[k + 1]?.text === ":") out.push(t.text);
    segmentStart = t.text === ",";
    if ((t.text === "(" || t.text === "[" || t.text === "{") && pairs.close[k]! < close) k = pairs.close[k]!;
  }
  return out;
}

/**
 * The expression in tokens [from, before) continues at the cursor. Suggest values unless
 * the cursor follows a complete operand (`a |` expects an operator).
 */
function expressionTail(structure: SourceStructure, from: number, before: number, expected: Expected | undefined): Site {
  const { tokens } = structure;
  if (from >= before) return { kind: "expression", ...(expected ? { expected } : {}) };
  const last = tokens[before - 1]!;
  if (last.text === "new") return { kind: "typeName", purpose: "new" };
  if (last.text === "emit" || last.text === "revert") return { kind: "expression", keyword: last.text };
  const operandEnd = last.kind === "number" || last.kind === "string" || last.text === ")" || last.text === "]" || (last.kind === "ident" && !KEYWORDS_EXPECTING_MORE.has(last.text));
  if (operandEnd) return NONE;
  // `x = |`, `a == |`: the value should match the left-hand side, whatever the whole expression is for
  // (`require(a == |)` expects a bool, but the operand an `a`). A declaration names its own type.
  if (ASSIGNMENTS.has(last.text) || COMPARISONS.has(last.text)) {
    const lhs = parseBackward(structure, before - 2);
    const declaration = expected?.kind === "type" && expected.name !== undefined && last.text === "=" && tokens[before - 2]?.text === expected.name;
    if (lhs && lhs.first >= from && !declaration) return { kind: "expression", expected: { kind: "sameAs", expr: lhs.expr } };
  }
  return { kind: "expression", ...(expected ? { expected } : {}) };
}

function parseTypeAt(structure: SourceStructure, i: number, end: number): number {
  return parseType(structure.tokens, structure.pairs, i, end);
}

// ---- expressions ------------------------------------------------------------------

/** Parses the postfix expression that ends at token `k` (`a.b(c)[d]`, `type(X)`, `payable(x)`). */
export function parseBackward(structure: SourceStructure, k: number): { expr: Expr; first: number } | undefined {
  const { tokens, pairs } = structure;
  const tk = tokens[k];
  if (!tk) return undefined;
  if (tk.kind === "string") return { expr: { kind: "literal", type: "string" }, first: k };
  if (tk.kind === "number") return { expr: { kind: "literal", type: "number" }, first: k };
  if (tk.text === ")") {
    const open = pairs.open[k]!;
    if (open < 0) return undefined;
    let calleeEnd = open - 1;
    if (tokens[calleeEnd]?.text === "}") {
      const optionsOpen = pairs.open[calleeEnd]!;
      if (optionsOpen < 0) return undefined;
      calleeEnd = optionsOpen - 1;
    }
    const c = tokens[calleeEnd];
    if (c && c.text === "type" && tokens[calleeEnd - 1]?.text !== ".") return { expr: { kind: "typeOf", type: typeText(tokens, open + 1, k) }, first: calleeEnd };
    if (c && !NOT_CALLEES.has(c.text) && (c.kind === "ident" || c.text === ")" || c.text === "]")) {
      const callee = parseBackward(structure, calleeEnd);
      if (!callee) return undefined;
      return { expr: { kind: "call", callee: callee.expr, args: callArgs(structure, open) }, first: callee.first };
    }
    // Parenthesized expression.
    const inner = parseBackward(structure, k - 1);
    return inner && inner.first === open + 1 ? { expr: inner.expr, first: open } : undefined;
  }
  if (tk.text === "]") {
    const open = pairs.open[k]!;
    if (open < 0) return undefined;
    const object = parseBackward(structure, open - 1);
    return object ? { expr: { kind: "index", object: object.expr }, first: object.first } : undefined;
  }
  if (tk.kind !== "ident") return undefined;
  if (tk.text === "true" || tk.text === "false") return { expr: { kind: "literal", type: "bool" }, first: k };
  if (tokens[k - 1]?.text === "new") return { expr: { kind: "new", type: tk.text }, first: k - 1 };
  if (tokens[k - 1]?.text === ".") {
    const object = parseBackward(structure, k - 2);
    return object ? { expr: { kind: "member", object: object.expr, name: tk.text }, first: object.first } : undefined;
  }
  return { expr: { kind: "name", name: tk.text }, first: k };
}
