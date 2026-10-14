import { tokenize, type Token } from "../completion/tokens";
import { byteToUtf16Converter } from "../compiler/compile";
import type { ProjectModel } from "../project/projectModel";
import { blankTrivia } from "../solidity/lexContext";

/**
 * Declarations and references of a project, built from solc's AST.
 *
 * Declarations are keyed by `<absolute path>#<UTF-16 offset of the name>`, which is
 * stable across compilations (solc's ids are not) and equal to the key the
 * tolerant parser gives a local declaration. Occurrences are only kept for the
 * project's own files: library code is never edited.
 */

export type OccurrenceKind = "declaration" | "reference" | "namedArgument" | "natspec";

export interface Occurrence {
  readonly start: number;
  readonly end: number;
  readonly key: string;
  readonly kind: OccurrenceKind;
}

export interface IndexedDecl {
  readonly key: string;
  readonly file: string;
  readonly name: string;
  readonly nodeType: string;
  readonly nameStart: number;
  readonly nameEnd: number;
  readonly inLib: boolean;
  /** Name of the contract, struct, enum, function or event it belongs to. */
  readonly container?: string;
}

/** `Y` in `import {X as Y} from "...";`. */
export interface ImportAlias {
  readonly file: string;
  readonly local: string;
  readonly start: number;
  readonly end: number;
  /** Key of the imported declaration. */
  readonly key: string;
}

export interface ReferenceIndex {
  readonly decls: Map<string, IndexedDecl>;
  /** Occurrences per own file, sorted by offset. */
  readonly occurrences: Map<string, Occurrence[]>;
  /** Keys of the functions, modifiers and getters a declaration overrides or implements. */
  readonly bases: Map<string, string[]>;
  readonly aliases: ImportAlias[];
  /** Top-level declarations of each own file (contracts, free functions, structs...): keys, or `?` when unnamed. */
  readonly topLevel: Map<string, string[]>;
}

export function emptyIndex(): ReferenceIndex {
  return { decls: new Map(), occurrences: new Map(), bases: new Map(), aliases: [], topLevel: new Map() };
}

export const declKey = (file: string, nameStart: number) => `${file}#${nameStart}`;

/** Declarations that can be renamed or referred to by name. */
const DECLARATIONS = new Set([
  "ContractDefinition",
  "FunctionDefinition",
  "ModifierDefinition",
  "EventDefinition",
  "ErrorDefinition",
  "StructDefinition",
  "EnumDefinition",
  "EnumValue",
  "UserDefinedValueTypeDefinition",
  "VariableDeclaration",
]);

const NOT_DECLARATIONS = new Set(["PragmaDirective", "ImportDirective", "UsingForDirective"]);

interface AstNode {
  readonly nodeType: string;
  readonly id?: number;
  readonly src: string;
  readonly name?: string;
  readonly [key: string]: unknown;
}

interface AstSource {
  readonly id: number;
  readonly ast?: AstNode;
}

export interface IndexContext {
  readonly project: ProjectModel;
  /** Text of a file as compiled (own files may be unsaved buffers). */
  readonly textOf: (abs: string) => string;
}

interface Located {
  readonly file: string;
  readonly start: number;
  readonly end: number;
}

/** Indexes the AST of one compilation. */
export function indexAst(sources: Readonly<Record<string, AstSource>>, ctx: IndexContext): ReferenceIndex {
  return new Builder(sources, ctx).build();
}

class Builder {
  private readonly index = emptyIndex();
  private readonly files = new Map<number, string>();
  private readonly nodes = new Map<number, { node: AstNode; file: string; parent?: AstNode }>();
  private readonly converters = new Map<string, (byte: number) => number>();
  private readonly tokenCache = new Map<string, readonly Token[]>();
  private readonly own = new Map<string, boolean>();

  constructor(
    private readonly sources: Readonly<Record<string, AstSource>>,
    private readonly ctx: IndexContext,
  ) {}

  build(): ReferenceIndex {
    for (const [name, source] of Object.entries(this.sources)) {
      const file = this.ctx.project.absolutePath(name);
      this.files.set(source.id, file);
      if (source.ast) this.collect(source.ast, file, undefined);
    }
    for (const [name, source] of Object.entries(this.sources)) {
      const file = this.ctx.project.absolutePath(name);
      if (!source.ast || !this.isOwn(file)) continue;
      this.index.topLevel.set(
        file,
        ((source.ast["nodes"] as AstNode[] | undefined) ?? []).filter((n) => !NOT_DECLARATIONS.has(n.nodeType)).map((n) => this.decl(n.id)?.key ?? "?"),
      );
      this.visit(source.ast, undefined);
    }
    for (const list of this.index.occurrences.values()) list.sort((a, b) => a.start - b.start || a.end - b.end);
    return this.index;
  }

  private isOwn(file: string): boolean {
    let own = this.own.get(file);
    if (own === undefined) {
      own = this.ctx.project.contains(file) && this.ctx.project.areaOf(file) !== "lib";
      this.own.set(file, own);
    }
    return own;
  }

  /** First pass: every declaration by id, with the node that contains it. */
  private collect(node: unknown, file: string, parent: AstNode | undefined): void {
    if (Array.isArray(node)) {
      for (const n of node) this.collect(n, file, parent);
      return;
    }
    if (!node || typeof node !== "object") return;
    const n = node as AstNode;
    if (n.nodeType && n.id !== undefined && DECLARATIONS.has(n.nodeType)) this.nodes.set(n.id, { node: n, file, ...(parent ? { parent } : {}) });
    const next = n.nodeType && DECLARATIONS.has(n.nodeType) ? n : parent;
    for (const [k, v] of Object.entries(n)) if (k !== "typeDescriptions" && v && typeof v === "object") this.collect(v, file, next);
  }

  // ---- positions -------------------------------------------------------------

  private converter(file: string): (byte: number) => number {
    let c = this.converters.get(file);
    if (!c) {
      c = byteToUtf16Converter(this.ctx.textOf(file));
      this.converters.set(file, c);
    }
    return c;
  }

  private tokens(file: string): readonly Token[] {
    let t = this.tokenCache.get(file);
    if (!t) {
      t = tokenize(blankTrivia(this.ctx.textOf(file)));
      this.tokenCache.set(file, t);
    }
    return t;
  }

  /** A `start:length:source` location in UTF-16 offsets, or undefined when it is missing (`-1`). */
  private loc(src: unknown): Located | undefined {
    if (typeof src !== "string") return undefined;
    const [s, l, f] = src.split(":").map(Number) as [number, number, number];
    if (!(s >= 0) || !(l >= 0)) return undefined;
    const file = this.files.get(f);
    if (!file) return undefined;
    const conv = this.converter(file);
    return { file, start: conv(s), end: conv(s + l) };
  }

  /** Identifier tokens within a location. */
  private identsIn(at: Located): Token[] {
    const tokens = this.tokens(at.file);
    let lo = 0;
    let hi = tokens.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tokens[mid]!.start < at.start) lo = mid + 1;
      else hi = mid;
    }
    const out: Token[] = [];
    for (let k = lo; k < tokens.length && tokens[k]!.end <= at.end; k++) if (tokens[k]!.kind === "ident") out.push(tokens[k]!);
    return out;
  }

  private textAt(at: Located): string {
    return this.ctx.textOf(at.file).slice(at.start, at.end);
  }

  // ---- declarations --------------------------------------------------------

  private readonly declCache = new Map<number, IndexedDecl | null>();

  private decl(id: unknown): IndexedDecl | undefined {
    if (typeof id !== "number" || id < 0) return undefined;
    const cached = this.declCache.get(id);
    if (cached !== undefined) return cached ?? undefined;
    const entry = this.nodes.get(id);
    const decl = entry ? this.makeDecl(entry.node, entry.file, entry.parent) : undefined;
    this.declCache.set(id, decl ?? null);
    return decl;
  }

  private makeDecl(node: AstNode, file: string, parent: AstNode | undefined): IndexedDecl | undefined {
    const name = node.name;
    if (!name) return undefined;
    const at = this.nameLocation(node, name);
    if (!at) return undefined;
    const key = declKey(at.file, at.start);
    const decl: IndexedDecl = {
      key,
      file: at.file,
      name,
      nodeType: node.nodeType,
      nameStart: at.start,
      nameEnd: at.end,
      inLib: !this.isOwn(at.file),
      ...(parent?.name ? { container: parent.name } : {}),
    };
    this.index.decls.set(key, decl);
    return decl;
  }

  private nameLocation(node: AstNode, name: string): Located | undefined {
    const direct = this.loc(node["nameLocation"]);
    if (direct && this.textAt(direct) === name) return direct;
    // solc < 0.8.2 has no nameLocation: the first token with the name after the type, if any.
    const whole = this.loc(node.src);
    if (!whole) return undefined;
    const typeEnd = this.loc((node["typeName"] as AstNode | undefined)?.src)?.end ?? whole.start;
    const tok = this.identsIn(whole).find((t) => t.start >= typeEnd && t.text === name);
    return tok ? { file: whole.file, start: tok.start, end: tok.end } : undefined;
  }

  // ---- occurrences ---------------------------------------------------------

  private add(at: Located | undefined, decl: IndexedDecl | undefined, kind: OccurrenceKind): void {
    if (!at || !decl || !this.isOwn(at.file)) return;
    let list = this.index.occurrences.get(at.file);
    if (!list) {
      list = [];
      this.index.occurrences.set(at.file, list);
    }
    list.push({ start: at.start, end: at.end, key: decl.key, kind });
  }

  private visit(node: unknown, contract: AstNode | undefined): void {
    if (Array.isArray(node)) {
      for (const n of node) this.visit(n, contract);
      return;
    }
    if (!node || typeof node !== "object") return;
    const n = node as AstNode;
    if (n.nodeType === "ContractDefinition") contract = n;
    switch (n.nodeType) {
      case "Identifier":
        this.add(this.loc(n.src), this.decl(n["referencedDeclaration"]), "reference");
        break;
      case "IdentifierPath":
        this.path(n);
        break;
      case "UserDefinedTypeName":
        if (!n["pathNode"]) this.path(n);
        break;
      case "MemberAccess":
        this.member(n);
        break;
      case "FunctionCall":
        this.namedArguments(n);
        break;
      case "ImportDirective":
        this.importAliases(n);
        break;
      case "InlineAssembly":
        for (const ref of (n["externalReferences"] as Array<{ declaration: number; src: string }> | undefined) ?? []) {
          const decl = this.decl(ref.declaration);
          const at = this.loc(ref.src);
          if (decl && at) this.add({ file: at.file, start: at.start, end: at.start + decl.name.length }, decl, "reference");
        }
        break;
    }
    if (n.id !== undefined && DECLARATIONS.has(n.nodeType)) this.declaration(n, contract);
    for (const [k, v] of Object.entries(n)) if (k !== "typeDescriptions" && v && typeof v === "object") this.visit(v, contract);
  }

  private declaration(n: AstNode, contract: AstNode | undefined): void {
    const decl = this.decl(n.id);
    if (!decl) return;
    this.add({ file: decl.file, start: decl.nameStart, end: decl.nameEnd }, decl, "declaration");
    const bases = [...((n["baseFunctions"] as number[] | undefined) ?? []), ...((n["baseModifiers"] as number[] | undefined) ?? [])];
    const keys = bases.map((b) => this.decl(b)?.key).filter((k): k is string => !!k);
    if (keys.length) this.index.bases.set(decl.key, keys);
    const doc = n["documentation"] as AstNode | undefined;
    if (doc && typeof doc === "object" && doc.nodeType === "StructuredDocumentation") this.natspec(n, doc, contract);
  }

  /** `A.B.C` in a type, base, modifier or `using` path: the last segment, then its containers. */
  private path(n: AstNode): void {
    const at = this.loc(n.src);
    const name = n.name;
    if (!at || typeof name !== "string" || !name) return;
    const segments = name.split(".");
    let locations = ((n["nameLocations"] as string[] | undefined) ?? []).map((l) => this.loc(l));
    if (locations.length !== segments.length || locations.some((l) => !l)) {
      const idents = this.identsIn(at);
      if (idents.length !== segments.length) return;
      locations = idents.map((t) => ({ file: at.file, start: t.start, end: t.end }));
    }
    let id: unknown = n["referencedDeclaration"];
    for (let k = segments.length - 1; k >= 0 && typeof id === "number"; k--) {
      const decl = this.decl(id);
      if (!decl || (k < segments.length - 1 && decl.name !== segments[k])) return;
      this.add(locations[k], decl, "reference");
      id = this.nodes.get(id)?.parent?.id;
    }
  }

  private member(n: AstNode): void {
    const decl = this.decl(n["referencedDeclaration"]);
    if (!decl) return;
    const name = n["memberName"] as string;
    let at = this.loc(n["memberLocation"]);
    if (!at || this.textAt(at) !== name) {
      const whole = this.loc(n.src);
      const tok = whole ? this.identsIn(whole).filter((t) => t.text === name).at(-1) : undefined;
      at = whole && tok ? { file: whole.file, start: tok.start, end: tok.end } : undefined;
    }
    this.add(at, decl, "reference");
  }

  /** Keys of `S({field: ...})`, `f({arg: ...})`, `emit E({arg: ...})`, `revert Err({arg: ...})`. */
  private namedArguments(n: AstNode): void {
    const names = (n["names"] as string[] | undefined) ?? [];
    if (!names.length) return;
    let callee = n["expression"] as AstNode | undefined;
    while (callee?.nodeType === "FunctionCallOptions") callee = callee["expression"] as AstNode | undefined;
    const target = typeof callee?.["referencedDeclaration"] === "number" ? this.nodes.get(callee["referencedDeclaration"] as number)?.node : undefined;
    if (!target) return;
    const members =
      target.nodeType === "StructDefinition"
        ? ((target["members"] as AstNode[] | undefined) ?? [])
        : (((target["parameters"] as AstNode | undefined)?.["parameters"] as AstNode[] | undefined) ?? []);
    let locations = ((n["nameLocations"] as string[] | undefined) ?? []).map((l) => this.loc(l));
    if (locations.length !== names.length || locations.some((l) => !l)) locations = this.namedArgumentLocations(n, callee, names);
    names.forEach((name, i) => {
      const member = members.find((m) => m.name === name);
      if (member) this.add(locations[i], this.decl(member.id), "namedArgument");
    });
  }

  /** solc < 0.8.16: the `name:` tokens directly inside the call's `({ ... })`. */
  private namedArgumentLocations(n: AstNode, callee: AstNode | undefined, names: readonly string[]): Array<Located | undefined> {
    const whole = this.loc(n.src);
    const calleeEnd = this.loc(callee?.src)?.end;
    if (!whole || calleeEnd === undefined) return [];
    const tokens = this.tokens(whole.file);
    let k = tokens.findIndex((t) => t.start >= calleeEnd);
    while (k >= 0 && k < tokens.length && tokens[k]!.text !== "{") k++;
    const found = new Map<string, Located>();
    let depth = 0;
    for (; k >= 0 && k < tokens.length && tokens[k]!.start < whole.end; k++) {
      const t = tokens[k]!.text;
      if (t === "(" || t === "[" || t === "{") depth++;
      else if (t === ")" || t === "]" || t === "}") depth--;
      else if (depth === 1 && tokens[k]!.kind === "ident" && tokens[k + 1]?.text === ":" && !found.has(t)) {
        found.set(t, { file: whole.file, start: tokens[k]!.start, end: tokens[k]!.end });
      }
      if (depth === 0) break;
    }
    return names.map((name) => found.get(name));
  }

  private importAliases(n: AstNode): void {
    const whole = this.loc(n.src);
    if (!whole || !this.isOwn(whole.file)) return;
    const idents = this.identsIn(whole);
    for (const alias of (n["symbolAliases"] as Array<{ foreign: AstNode; local?: string | null }> | undefined) ?? []) {
      const decl = this.decl(alias.foreign["referencedDeclaration"]);
      const foreignAt = this.loc(alias.foreign.src);
      if (!decl || !foreignAt || !alias.local) continue;
      // `X as Y`: the identifier after `as` following the foreign name.
      const k = idents.findIndex((t) => t.start === foreignAt.start);
      const local = k >= 0 && idents[k + 1]?.text === "as" ? idents[k + 2] : undefined;
      if (local?.text === alias.local) this.index.aliases.push({ file: whole.file, local: alias.local, start: local.start, end: local.end, key: decl.key });
    }
  }

  /** `@param x` / `@return x` of the node's parameters, `@inheritdoc Base`. */
  private natspec(n: AstNode, doc: AstNode, contract: AstNode | undefined): void {
    const at = this.loc(doc.src);
    if (!at) return;
    const text = this.textAt(at);
    const params = (key: string) => (((n[key] as AstNode | undefined)?.["parameters"] as AstNode[] | undefined) ?? []);
    const tag = /@(param|return|inheritdoc)[ \t]+([A-Za-z_$][\w$]*)/g;
    for (let m = tag.exec(text); m; m = tag.exec(text)) {
      const name = m[2]!;
      let target: IndexedDecl | undefined;
      if (m[1] === "param") target = this.decl(params("parameters").find((p) => p.name === name)?.id);
      else if (m[1] === "return") target = this.decl(params("returnParameters").find((p) => p.name === name)?.id);
      else {
        const bases = (contract?.["linearizedBaseContracts"] as number[] | undefined) ?? [];
        target = bases.map((b) => this.decl(b)).find((d) => d?.name === name);
      }
      const start = at.start + m.index + m[0].length - name.length;
      if (target) this.add({ file: at.file, start, end: start + name.length }, target, "natspec");
    }
  }
}

/** Joins the indexes of several compilations (one per solc version), without duplicates. */
export function mergeIndexes(indexes: readonly ReferenceIndex[]): ReferenceIndex {
  if (indexes.length === 1) return indexes[0]!;
  const out = emptyIndex();
  const seen = new Set<string>();
  for (const index of indexes) {
    for (const [k, d] of index.decls) out.decls.set(k, d);
    for (const [file, list] of index.occurrences) {
      const target = out.occurrences.get(file) ?? [];
      for (const o of list) {
        const id = `${file}:${o.start}:${o.key}`;
        if (seen.has(id)) continue;
        seen.add(id);
        target.push(o);
      }
      out.occurrences.set(file, target);
    }
    for (const [k, bases] of index.bases) out.bases.set(k, [...new Set([...(out.bases.get(k) ?? []), ...bases])]);
    for (const a of index.aliases) if (!out.aliases.some((b) => b.file === a.file && b.start === a.start)) out.aliases.push(a);
    for (const [file, keys] of index.topLevel) out.topLevel.set(file, keys);
  }
  for (const list of out.occurrences.values()) list.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}
