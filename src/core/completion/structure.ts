import { blankTrivia, scanTrivia, type TriviaRange } from "../solidity/lexContext";
import { matchBrackets, tokenize, type BracketPairs, type Token } from "./tokens";

/**
 * Tolerant structural analysis of a Solidity file for completion: contracts
 * and their members, functions with parameters, local variables per block and
 * the span of every statement. Unlike @solidity-parser/parser it never throws
 * and keeps going on half-written code (unclosed brackets and blocks, missing
 * semicolons, trailing commas).
 */

export type DeclKind =
  | "contract"
  | "abstract"
  | "interface"
  | "library"
  | "struct"
  | "enum"
  | "event"
  | "error"
  | "type"
  | "function"
  | "modifier"
  | "stateVariable"
  | "constant"
  | "immutable"
  | "parameter"
  | "return"
  | "local"
  | "field"
  | "enumValue";

export interface Param {
  readonly type: string;
  readonly name?: string;
  /** memory, storage, calldata, indexed. */
  readonly location?: string;
}

export interface Decl {
  readonly name: string;
  readonly kind: DeclKind;
  /** Type as written, whitespace normalized (`mapping(address => uint256)`, `address payable`). */
  readonly type?: string;
  /** Data location (`memory`, `storage`, `calldata`) or `indexed`, for parameters and locals. */
  readonly location?: string;
  readonly nameStart: number;
  /** Offset from which a local declaration is visible. */
  readonly visibleFrom: number;
  readonly params?: readonly Param[];
  readonly returns?: readonly Param[];
  readonly visibility?: string;
  readonly mutability?: string;
  /** Fields of a struct, values of an enum. */
  readonly members?: readonly Decl[];
  /** Base contracts as written, for contracts. */
  readonly bases?: readonly string[];
}

export type CallableKind = "function" | "modifier" | "constructor" | "fallback" | "receive";

export interface Callable {
  readonly kind: CallableKind;
  readonly name: string;
  readonly start: number;
  /** End of the header: the body's `{`, the `;`, or where the header was cut short. */
  readonly headerEnd: number;
  readonly end: number;
  readonly params: readonly Decl[];
  readonly returns: readonly Decl[];
  readonly owner?: ContractNode;
}

export interface ContractNode {
  readonly decl: Decl;
  readonly start: number;
  /** Just after the `{` of the body (the end of the header when there is none). */
  readonly bodyStart: number;
  readonly end: number;
  readonly members: readonly Decl[];
}

export type ContainerKind = "contract" | "struct" | "enum" | "body" | "assembly";

/** A region delimited by braces: where a statement starting at the cursor belongs. */
export interface Container {
  readonly kind: ContainerKind;
  /** Just after the `{`. */
  readonly start: number;
  /** Offset of the `}` (or end of text). */
  readonly end: number;
}

export interface LocalScope {
  readonly start: number;
  readonly end: number;
  readonly decls: readonly Decl[];
}

export interface StatementSpan {
  readonly container: "file" | "contract" | "struct" | "enum" | "body";
  /** Token index of the first token. */
  readonly first: number;
  /** Token index after the last token. */
  readonly last: number;
  readonly start: number;
  /** End of the last token. */
  readonly end: number;
  /** True when ended by `;` (included) or by the `{` of a body (excluded). */
  readonly terminated: boolean;
}

export interface SourceStructure {
  readonly text: string;
  readonly clean: string;
  readonly trivia: readonly TriviaRange[];
  readonly tokens: readonly Token[];
  readonly pairs: BracketPairs;
  /** File-level declarations, contracts included. */
  readonly fileDecls: readonly Decl[];
  readonly contracts: readonly ContractNode[];
  readonly callables: readonly Callable[];
  readonly containers: readonly Container[];
  readonly scopes: readonly LocalScope[];
  readonly statements: readonly StatementSpan[];
  /** Pragma and import statements, assembly blocks: no completion there. */
  readonly silent: ReadonlyArray<readonly [number, number]>;
}

export const DATA_LOCATIONS = new Set(["memory", "storage", "calldata"]);

/** Words that never start a type. */
const NOT_A_TYPE = new Set([
  "return", "emit", "if", "else", "for", "while", "do", "break", "continue", "delete", "new", "unchecked", "try", "catch",
  "assembly", "true", "false", "this", "super", "public", "private", "internal", "external", "memory", "storage", "calldata",
  "constant", "immutable", "override", "virtual", "payable", "view", "pure", "indexed", "anonymous", "returns", "using",
  "import", "pragma", "contract", "interface", "library", "abstract", "struct", "enum", "event", "error", "modifier",
  "constructor", "is", "as", "transient", "type", "function", "revert", "msg", "block", "tx", "abi",
]);

const STATE_ATTRIBUTES = new Set(["public", "private", "internal", "constant", "immutable", "override", "transient"]);
const VISIBILITY = new Set(["public", "private", "internal", "external"]);
const MUTABILITY = new Set(["view", "pure", "payable"]);
const CONTRACT_KEYWORDS = new Set(["contract", "interface", "library", "abstract"]);
const MEMBER_KEYWORDS = new Set(["function", "modifier", "constructor", "event", "error", "struct", "enum", "using"]);

export function parseStructure(text: string): SourceStructure {
  const trivia = scanTrivia(text);
  const clean = blankTrivia(text, trivia);
  const tokens = tokenize(clean);
  const pairs = matchBrackets(tokens);
  const p = new StructureParser(text, tokens, pairs);
  p.file();
  return {
    text,
    clean,
    trivia,
    tokens,
    pairs,
    fileDecls: p.fileDecls,
    contracts: p.contracts,
    callables: p.callables,
    containers: p.containers,
    scopes: p.scopes,
    statements: p.statements,
    silent: p.silent,
  };
}

/**
 * Parses a type at token `i`: elementary or user-defined path (`A.B`), `address payable`,
 * `mapping(...)`, function types, with any number of `[...]`. Returns the index after it, or -1.
 */
export function parseType(t: readonly Token[], pairs: BracketPairs, i: number, end: number): number {
  const after = (k: number) => {
    const c = pairs.close[k]!;
    if (c < 0) return k + 1;
    return pairs.closed[k] ? c + 1 : c;
  };
  const tk = t[i];
  if (!tk || tk.kind !== "ident" || i >= end) return -1;
  let j: number;
  if (tk.text === "mapping" && t[i + 1]?.text === "(") {
    j = after(i + 1);
  } else if (tk.text === "function" && t[i + 1]?.text === "(") {
    j = after(i + 1);
    while (j < end && t[j]?.kind === "ident" && ["internal", "external", "pure", "view", "payable"].includes(t[j]!.text)) j++;
    if (t[j]?.text === "returns" && t[j + 1]?.text === "(") j = after(j + 1);
  } else {
    if (NOT_A_TYPE.has(tk.text)) return -1;
    j = i + 1;
    while (j + 1 < end && t[j]?.text === "." && t[j + 1]?.kind === "ident") j += 2;
    if (tk.text === "address" && t[j]?.text === "payable") j++;
  }
  while (j < end && t[j]?.text === "[") j = after(j);
  return Math.min(j, end);
}

/** Normalized text of a type spanning tokens [from, to). */
export function typeText(tokens: readonly Token[], from: number, to: number): string {
  let out = "";
  for (let k = from; k < to; k++) {
    const t = tokens[k]!.text;
    const prev = out.at(-1);
    if (t === "=>") out += " => ";
    else if (t === ",") out += ", ";
    else if (t === "." || t === "(" || t === ")" || t === "[" || t === "]") out += t;
    else out += prev && prev !== "(" && prev !== "[" && prev !== "." && prev !== " " ? ` ${t}` : t;
  }
  return out.replace(/\s+/g, " ").trim();
}

class StructureParser {
  readonly fileDecls: Decl[] = [];
  readonly contracts: ContractNode[] = [];
  readonly callables: Callable[] = [];
  readonly containers: Container[] = [];
  readonly scopes: LocalScope[] = [];
  readonly statements: StatementSpan[] = [];
  readonly silent: Array<[number, number]> = [];
  private readonly n: number;

  constructor(
    private readonly text: string,
    private readonly t: readonly Token[],
    private readonly pairs: BracketPairs,
  ) {
    this.n = t.length;
  }

  file(): void {
    let i = 0;
    while (i < this.n) {
      const next = this.fileStatement(i);
      i = next > i ? next : i + 1;
    }
  }

  // ---- helpers -------------------------------------------------------------

  private tok(i: number): Token | undefined {
    return this.t[i];
  }

  private is(i: number, text: string): boolean {
    return this.t[i]?.text === text;
  }

  private ident(i: number): boolean {
    return this.t[i]?.kind === "ident";
  }

  /** Index after the group opened at `i`. A cut-short group ends before the token that cut it. */
  private after(i: number): number {
    const c = this.pairs.close[i]!;
    if (c < 0) return i + 1;
    return this.pairs.closed[i] ? c + 1 : c;
  }

  /** Offset of the end of the group opened at `i` (its closer, or where it was cut). */
  private groupEnd(i: number): number {
    const c = this.pairs.close[i]!;
    return c >= 0 && c < this.n ? this.t[c]!.start : this.text.length;
  }

  private offsetAt(i: number): number {
    return i < this.n ? this.t[i]!.start : this.text.length;
  }

  private endOf(i: number): number {
    const k = Math.min(i, this.n);
    return k > 0 ? this.t[k - 1]!.end : 0;
  }

  private span(container: StatementSpan["container"], first: number, last: number, terminated: boolean): void {
    last = Math.min(last, this.n);
    if (last <= first) return;
    this.statements.push({ container, first, last, start: this.t[first]!.start, end: this.t[last - 1]!.end, terminated });
  }

  /** Skips to after the next `;` at this level, stopping before `}` or a declaration keyword (`stop`). */
  private skipStatement(i: number, end: number, stop: (k: number) => boolean = () => false): { next: number; terminated: boolean } {
    let k = i;
    while (k < end) {
      const tk = this.t[k]!;
      if (tk.text === ";") return { next: k + 1, terminated: true };
      if (tk.text === "}") return { next: k, terminated: false };
      if (k > i && stop(k)) return { next: k, terminated: false };
      if (tk.text === "(" || tk.text === "[" || tk.text === "{") {
        k = this.after(k);
        continue;
      }
      k++;
    }
    return { next: Math.min(k, end), terminated: false };
  }

  parseType(i: number, end: number): number {
    return parseType(this.t, this.pairs, i, end);
  }

  /** `Type [location|indexed]* [name]` items of the parameter list opened at `open`. */
  private params(open: number, kind: "parameter" | "return" | "field", visibleFrom: number): Decl[] {
    const out: Decl[] = [];
    const end = Math.min(this.pairs.close[open]!, this.n);
    let k = open + 1;
    while (k < end) {
      let segEnd = k;
      while (segEnd < end && !this.is(segEnd, ",")) segEnd = this.is(segEnd, "(") || this.is(segEnd, "[") || this.is(segEnd, "{") ? this.after(segEnd) : segEnd + 1;
      segEnd = Math.min(segEnd, end);
      const typeEnd = this.parseType(k, segEnd);
      if (typeEnd > k) {
        let j = typeEnd;
        let location: string | undefined;
        while (j < segEnd && this.ident(j) && (DATA_LOCATIONS.has(this.t[j]!.text) || this.t[j]!.text === "indexed")) location = this.t[j++]!.text;
        const type = typeText(this.t, k, typeEnd);
        const nameTok = j < segEnd && this.ident(j) ? this.t[j] : undefined;
        out.push({
          name: nameTok?.text ?? "",
          kind,
          type,
          nameStart: nameTok?.start ?? this.t[k]!.start,
          visibleFrom,
          ...(location ? { location } : {}),
        });
      }
      k = segEnd + 1;
    }
    return out;
  }

  // ---- file level ----------------------------------------------------------

  private fileStatement(i: number): number {
    const tk = this.t[i]!;
    if (tk.text === "pragma" || tk.text === "import") {
      const { next } = this.skipStatement(i, this.n, (k) => this.startsDeclaration(k));
      this.silent.push([tk.start, this.endOf(next)]);
      return next;
    }
    if (CONTRACT_KEYWORDS.has(tk.text)) return this.contract(i);
    const member = this.memberStatement(i, this.n, "file", undefined);
    return member.next;
  }

  private startsDeclaration(k: number): boolean {
    const text = this.t[k]!.text;
    return CONTRACT_KEYWORDS.has(text) || text === "pragma" || text === "import" || (MEMBER_KEYWORDS.has(text) && text !== "using");
  }

  private contract(i: number): number {
    const start = i;
    let kind: DeclKind = "contract";
    if (this.is(i, "abstract")) {
      kind = "abstract";
      i++;
    }
    const keyword = this.t[i]?.text;
    if (keyword === "interface" || keyword === "library") kind = keyword;
    i++;
    const nameTok = this.ident(i) && this.t[i]!.text !== "is" ? this.t[i++] : undefined;
    const bases: string[] = [];
    if (this.is(i, "is")) {
      i++;
      while (i < this.n && !this.is(i, "{") && !this.startsDeclaration(i) && !this.is(i, ";")) {
        if (this.ident(i)) {
          let j = i + 1;
          while (this.is(j, ".") && this.ident(j + 1)) j += 2;
          bases.push(typeText(this.t, i, j));
          i = j;
          if (this.is(i, "(")) i = this.after(i);
        } else i++;
      }
    }
    const members: Decl[] = [];
    const decl: Decl = { name: nameTok?.text ?? "", kind, nameStart: nameTok?.start ?? this.t[start]!.start, visibleFrom: 0, members, bases };
    this.fileDecls.push(decl);
    if (!this.is(i, "{")) {
      this.span("file", start, i, false);
      this.contracts.push({ decl, start: this.t[start]!.start, bodyStart: this.endOf(i), end: this.endOf(i), members });
      return i;
    }
    this.span("file", start, i, true);
    const open = i;
    const close = Math.min(this.pairs.close[open]!, this.n);
    const node: ContractNode = { decl, start: this.t[start]!.start, bodyStart: this.t[open]!.end, end: this.groupEnd(open), members };
    let k = open + 1;
    while (k < close) {
      if (CONTRACT_KEYWORDS.has(this.t[k]!.text) || this.is(k, "pragma") || this.is(k, "import")) {
        // A contract left open: the next one starts here.
        const cut: ContractNode = { ...node, end: this.t[k]!.start };
        this.contracts.push(cut);
        this.containers.push({ kind: "contract", start: node.bodyStart, end: cut.end });
        return k;
      }
      const next = this.memberStatement(k, close, "contract", node).next;
      k = next > k ? next : k + 1;
    }
    this.contracts.push(node);
    this.containers.push({ kind: "contract", start: node.bodyStart, end: node.end });
    return this.after(open);
  }

  // ---- members (contract or file level) -----------------------------------

  private memberStatement(i: number, end: number, container: "file" | "contract", owner: ContractNode | undefined): { next: number } {
    const target = owner ? (owner.members as Decl[]) : this.fileDecls;
    const tk = this.t[i]!;
    const text = tk.text;
    if (text === "}") return { next: i + 1 };
    if (text === "function" && !this.is(i + 1, "(")) return { next: this.callable(i, end, "function", container, owner, target) };
    if (text === "modifier") return { next: this.callable(i, end, "modifier", container, owner, target) };
    if (text === "constructor") return { next: this.callable(i, end, "constructor", container, owner, target) };
    if ((text === "fallback" || text === "receive") && this.is(i + 1, "(")) return { next: this.callable(i, end, text, container, owner, target) };
    if (text === "struct") return { next: this.struct(i, end, container, target) };
    if (text === "enum") return { next: this.enumDecl(i, end, container, target) };
    if (text === "event" || text === "error") {
      const nameTok = this.ident(i + 1) ? this.t[i + 1]! : undefined;
      const params = this.is(i + 2, "(") ? this.params(i + 2, "parameter", 0) : [];
      const { next, terminated } = this.skipStatement(i, end, (k) => this.startsDeclaration(k));
      this.span(container, i, next, terminated);
      if (nameTok) target.push({ name: nameTok.text, kind: text, nameStart: nameTok.start, visibleFrom: 0, params: params.map(toParam) });
      return { next };
    }
    if (text === "type" && this.ident(i + 1) && this.is(i + 2, "is")) {
      const { next, terminated } = this.skipStatement(i, end, (k) => this.startsDeclaration(k));
      this.span(container, i, next, terminated);
      const typeEnd = this.parseType(i + 3, next);
      target.push({
        name: this.t[i + 1]!.text,
        kind: "type",
        nameStart: this.t[i + 1]!.start,
        visibleFrom: 0,
        ...(typeEnd > 0 ? { type: typeText(this.t, i + 3, typeEnd) } : {}),
      });
      return { next };
    }
    // State variable, file-level constant, `using`, or something half-written.
    const { next, terminated } = this.skipStatement(i, end, (k) => this.startsDeclaration(k) || this.newDeclarationLine(i, k));
    this.span(container, i, next, terminated);
    if (text === "using") return { next };
    const typeEnd = this.parseType(i, next);
    if (typeEnd < 0) return { next };
    let j = typeEnd;
    let constant = false;
    let immutable = false;
    let visibility: string | undefined;
    while (j < next && this.ident(j) && STATE_ATTRIBUTES.has(this.t[j]!.text)) {
      const a = this.t[j]!.text;
      if (a === "constant") constant = true;
      if (a === "immutable") immutable = true;
      if (VISIBILITY.has(a)) visibility = a;
      j = this.is(j + 1, "(") && a === "override" ? this.after(j + 1) : j + 1;
    }
    if (j < next && this.ident(j) && !NOT_A_TYPE.has(this.t[j]!.text)) {
      const nameTok = this.t[j]!;
      target.push({
        name: nameTok.text,
        kind: constant ? "constant" : immutable ? "immutable" : "stateVariable",
        type: typeText(this.t, i, typeEnd),
        nameStart: nameTok.start,
        visibleFrom: 0,
        ...(visibility ? { visibility } : {}),
      });
    }
    return { next };
  }

  /** In a contract, a new line starting with a type and a name after a complete declaration means a missing `;`. */
  private newDeclarationLine(first: number, k: number): boolean {
    const prev = this.t[k - 1]!;
    const tk = this.t[k]!;
    if (prev.line === tk.line || tk.kind !== "ident") return false;
    if (!(prev.kind === "ident" || prev.kind === "number" || prev.kind === "string" || prev.text === ")" || prev.text === "]")) return false;
    // The statement so far must already declare something (`uint256 x` or `uint256 x = 1`).
    const typeEnd = this.parseType(first, k);
    if (typeEnd < 0 || typeEnd >= k) return false;
    const typeHere = this.parseType(k, this.n);
    return typeHere > k && this.ident(typeHere);
  }

  private struct(i: number, end: number, container: "file" | "contract", target: Decl[]): number {
    const nameTok = this.ident(i + 1) ? this.t[i + 1]! : undefined;
    const open = nameTok ? i + 2 : i + 1;
    const fields: Decl[] = [];
    if (nameTok) target.push({ name: nameTok.text, kind: "struct", nameStart: nameTok.start, visibleFrom: 0, members: fields });
    if (!this.is(open, "{")) {
      this.span(container, i, open, false);
      return open;
    }
    this.span(container, i, open, true);
    const close = Math.min(this.pairs.close[open]!, end);
    this.containers.push({ kind: "struct", start: this.t[open]!.end, end: this.groupEnd(open) });
    let k = open + 1;
    while (k < close) {
      if (this.startsDeclaration(k)) return k; // Struct left open.
      const { next, terminated } = this.skipStatement(k, close, (x) => this.startsDeclaration(x));
      this.span("struct", k, next, terminated);
      const typeEnd = this.parseType(k, next);
      if (typeEnd > 0 && this.ident(typeEnd) && typeEnd < next) {
        const nameTok2 = this.t[typeEnd]!;
        fields.push({ name: nameTok2.text, kind: "field", type: typeText(this.t, k, typeEnd), nameStart: nameTok2.start, visibleFrom: 0 });
      }
      k = next > k ? next : k + 1;
    }
    return this.after(open);
  }

  private enumDecl(i: number, end: number, container: "file" | "contract", target: Decl[]): number {
    const nameTok = this.ident(i + 1) ? this.t[i + 1]! : undefined;
    const open = nameTok ? i + 2 : i + 1;
    const values: Decl[] = [];
    if (nameTok) target.push({ name: nameTok.text, kind: "enum", nameStart: nameTok.start, visibleFrom: 0, members: values });
    if (!this.is(open, "{")) {
      this.span(container, i, open, false);
      return open;
    }
    this.span(container, i, open, true);
    this.containers.push({ kind: "enum", start: this.t[open]!.end, end: this.groupEnd(open) });
    const close = Math.min(this.pairs.close[open]!, end);
    for (let k = open + 1; k < close; k++) {
      if (this.startsDeclaration(k)) return k;
      if (this.ident(k)) values.push({ name: this.t[k]!.text, kind: "enumValue", nameStart: this.t[k]!.start, visibleFrom: 0 });
    }
    this.span("enum", open + 1, close, false);
    return this.after(open);
  }

  private callable(
    i: number,
    end: number,
    kind: CallableKind,
    container: "file" | "contract",
    owner: ContractNode | undefined,
    target: Decl[],
  ): number {
    const start = i;
    let k = i + 1;
    let name: string = kind;
    let nameStart = this.t[i]!.start;
    if (kind === "function" || kind === "modifier") {
      if (this.ident(k)) {
        name = this.t[k]!.text;
        nameStart = this.t[k]!.start;
        k++;
      } else name = "";
    }
    let params: Decl[] = [];
    let returns: Decl[] = [];
    const paramsOpen = this.is(k, "(") ? k : -1;
    if (paramsOpen >= 0) k = this.after(k);
    let visibility: string | undefined;
    let mutability: string | undefined;
    let returnsOpen = -1;
    while (k < end) {
      const tk = this.t[k]!;
      if (tk.text === "{" || tk.text === ";" || tk.text === "}") break;
      if (tk.kind === "ident" && (this.startsDeclaration(k) || CONTRACT_KEYWORDS.has(tk.text))) break;
      if (tk.text === "returns" && this.is(k + 1, "(")) {
        returnsOpen = k + 1;
        k = this.after(k + 1);
        continue;
      }
      if (VISIBILITY.has(tk.text)) visibility = tk.text;
      if (MUTABILITY.has(tk.text)) mutability = tk.text;
      k = this.is(k + 1, "(") && tk.kind === "ident" ? this.after(k + 1) : k + 1;
    }
    const headerEnd = this.offsetAt(k);
    const visibleFrom = this.t[start]!.start;
    if (paramsOpen >= 0) params = this.params(paramsOpen, "parameter", visibleFrom);
    if (returnsOpen >= 0) returns = this.params(returnsOpen, "return", visibleFrom);
    const decl: Decl = {
      name,
      kind: kind === "modifier" ? "modifier" : "function",
      nameStart,
      visibleFrom: 0,
      params: params.map(toParam),
      returns: returns.map(toParam),
      ...(visibility ? { visibility } : {}),
      ...(mutability ? { mutability } : {}),
    };
    if ((kind === "function" && name) || kind === "modifier") target.push(decl);
    const terminated = this.is(k, "{") || this.is(k, ";");
    this.span(container, start, this.is(k, ";") ? k + 1 : k, terminated);
    let callableEnd = this.offsetAt(k);
    let next = this.is(k, ";") ? k + 1 : k;
    if (this.is(k, "{")) {
      const bodyEnd = this.block(k, end);
      next = bodyEnd.next;
      callableEnd = bodyEnd.end;
    }
    this.callables.push({ kind, name, start: this.t[start]!.start, headerEnd, end: callableEnd, params, returns, ...(owner ? { owner } : {}) });
    return next;
  }

  // ---- function bodies -----------------------------------------------------

  /** Parses the block opened at `open`. Returns the index after it and its end offset. */
  private block(open: number, limit: number, extra: readonly Decl[] = []): { next: number; end: number } {
    const close = Math.min(this.pairs.close[open]!, limit, this.n);
    const decls: Decl[] = [...extra];
    const start = this.t[open]!.end;
    let k = open + 1;
    let cutAt: number | undefined;
    while (k < close) {
      if (this.cutsBody(k)) {
        cutAt = k;
        break;
      }
      const next = this.statement(k, close, decls);
      k = next > k ? next : k + 1;
    }
    const end = cutAt !== undefined ? this.t[cutAt]!.start : this.groupEnd(open);
    this.containers.push({ kind: "body", start, end });
    this.scopes.push({ start, end, decls });
    return { next: cutAt ?? this.after(open), end };
  }

  /** A declaration keyword inside a body means the body was left unclosed. */
  private cutsBody(k: number): boolean {
    const tk = this.t[k]!;
    if (tk.kind !== "ident") return false;
    if (tk.text === "function") return this.ident(k + 1);
    return CONTRACT_KEYWORDS.has(tk.text) || tk.text === "modifier" || tk.text === "constructor" || tk.text === "event" || tk.text === "struct" || tk.text === "enum" || tk.text === "pragma" || tk.text === "import";
  }

  /** One statement inside a body, adding the declarations it makes to `decls`. */
  private statement(i: number, end: number, decls: Decl[]): number {
    const tk = this.t[i]!;
    switch (tk.text) {
      case "{":
        return this.block(i, end).next;
      case "unchecked":
        if (this.is(i + 1, "{")) {
          this.span("body", i, i + 1, true);
          return this.block(i + 1, end).next;
        }
        break;
      case "if":
      case "while":
        if (this.is(i + 1, "(")) {
          const after = this.after(i + 1);
          this.span("body", i, after, this.pairs.closed[i + 1] === 1);
          let k = after < end ? this.statement(after, end, decls) : after;
          if (tk.text === "if" && this.is(k, "else")) k = k + 1 < end ? this.statement(k + 1, end, decls) : k + 1;
          return k;
        }
        break;
      case "else":
        return i + 1 < end ? this.statement(i + 1, end, decls) : i + 1;
      case "do": {
        const k = i + 1 < end ? this.statement(i + 1, end, decls) : i + 1;
        if (this.is(k, "while")) return this.skipStatement(k, end).next;
        return k;
      }
      case "for":
        if (this.is(i + 1, "(")) return this.forStatement(i, end);
        break;
      case "try":
        return this.tryStatement(i, end);
      case "assembly": {
        let k = i + 1;
        while (k < end && !this.is(k, "{") && !this.is(k, ";")) k = this.is(k, "(") ? this.after(k) : k + 1;
        if (this.is(k, "{")) {
          const after = this.after(k);
          this.silent.push([this.t[k]!.start, this.groupEnd(k)]);
          this.containers.push({ kind: "assembly", start: this.t[k]!.end, end: this.groupEnd(k) });
          return after;
        }
        return k;
      }
    }
    return this.simpleStatement(i, end, decls);
  }

  private simpleStatement(i: number, end: number, decls: Decl[]): number {
    const { next, terminated } = this.skipStatement(i, end, (k) => this.cutsBody(k) || this.missingSemicolon(i, k));
    this.span("body", i, next, terminated);
    const visibleFrom = this.endOf(next);
    decls.push(...this.declarationsIn(i, next, visibleFrom));
    return next;
  }

  /** Declarations made by the simple statement spanning tokens [i, next). */
  private declarationsIn(i: number, next: number, visibleFrom: number): Decl[] {
    // `(uint a, , bool b) = f();`
    if (this.is(i, "(")) {
      const after = this.after(i);
      if (!this.is(after, "=")) return [];
      return this.params(i, "parameter", visibleFrom)
        .filter((d) => d.name)
        .map((d) => ({ ...d, kind: "local" as const }));
    }
    const typeEnd = this.parseType(i, next);
    if (typeEnd < 0) return [];
    let j = typeEnd;
    const location = j < next && DATA_LOCATIONS.has(this.t[j]!.text) ? this.t[j++]!.text : undefined;
    const nameTok = this.t[j];
    if (j >= next || !nameTok || nameTok.kind !== "ident" || NOT_A_TYPE.has(nameTok.text)) return [];
    if (j + 1 < next && !this.is(j + 1, "=") && !this.is(j + 1, ";")) return [];
    const type = typeText(this.t, i, typeEnd);
    return [{ name: nameTok.text, kind: "local", type, nameStart: nameTok.start, visibleFrom, ...(location ? { location } : {}) }];
  }

  /**
   * In a body, an expression followed by a new line that starts a declaration or a
   * statement means a missing `;` (`foo = 1` ⏎ `uint256 x = 2;`).
   */
  private missingSemicolon(first: number, k: number): boolean {
    const prev = this.t[k - 1]!;
    const tk = this.t[k]!;
    if (prev.line === tk.line || tk.kind !== "ident") return false;
    const expressionEnd = prev.kind === "number" || prev.kind === "string" || prev.text === ")" || prev.text === "]" || (prev.kind === "ident" && !NOT_A_TYPE.has(prev.text));
    if (!expressionEnd) return false;
    // `Listing memory` ⏎ `listing = ...` is one declaration.
    if (this.parseType(first, k) === k) return false;
    // An identifier cannot continue an expression: it starts a statement (`uint256 x`, `a = b`, `emit E()`).
    return true;
  }

  private forStatement(i: number, end: number): number {
    const open = i + 1;
    const close = Math.min(this.pairs.close[open]!, this.n);
    const decls: Decl[] = [];
    this.span("body", i, this.after(open), this.pairs.closed[open] === 1);
    // Init clause: up to the first `;` inside the parentheses.
    let k = open + 1;
    while (k < close && !this.is(k, ";")) k = this.is(k, "(") || this.is(k, "[") ? this.after(k) : k + 1;
    decls.push(...this.declarationsIn(open + 1, k, this.endOf(Math.min(k + 1, close))));
    const scopeStart = this.t[open]!.end;
    const after = this.after(open);
    let next = after;
    let scopeEnd = this.groupEnd(open);
    if (after < end) {
      if (this.is(after, "{")) {
        const b = this.block(after, end, decls);
        next = b.next;
        scopeEnd = b.end;
      } else {
        const inner: Decl[] = [];
        next = this.statement(after, end, inner);
        scopeEnd = this.endOf(next);
      }
    }
    this.scopes.push({ start: scopeStart, end: scopeEnd, decls });
    return next;
  }

  private tryStatement(i: number, end: number): number {
    let k = i + 1;
    while (k < end && !this.is(k, "{") && !this.is(k, "returns") && !this.is(k, ";") && !this.cutsBody(k)) {
      k = this.is(k, "(") || this.is(k, "[") ? this.after(k) : k + 1;
    }
    let returns: Decl[] = [];
    if (this.is(k, "returns") && this.is(k + 1, "(")) {
      returns = this.params(k + 1, "parameter", 0).map((d) => ({ ...d, kind: "local" as const }));
      k = this.after(k + 1);
    }
    this.span("body", i, k, this.is(k, "{"));
    if (!this.is(k, "{")) return k > i ? k : i + 1;
    k = this.block(k, end, returns).next;
    while (this.is(k, "catch")) {
      const start = k;
      k++;
      if (this.ident(k)) k++;
      let params: Decl[] = [];
      if (this.is(k, "(")) {
        params = this.params(k, "parameter", 0).map((d) => ({ ...d, kind: "local" as const }));
        k = this.after(k);
      }
      this.span("body", start, k, this.is(k, "{"));
      if (!this.is(k, "{")) return k;
      k = this.block(k, end, params).next;
    }
    return k;
  }
}

function toParam(d: Decl): Param {
  return { type: d.type ?? "", ...(d.name ? { name: d.name } : {}), ...(d.location ? { location: d.location } : {}) };
}
