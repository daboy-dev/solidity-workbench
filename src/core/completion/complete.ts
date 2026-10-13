import {
  ABI,
  BLOCK,
  CONTRACT_TYPE_INFO,
  ENUM_TYPE_INFO,
  GLOBAL_FUNCTIONS,
  GLOBAL_VALUES,
  INTERFACE_TYPE_INFO,
  MSG,
  TX,
  UNITS,
  isAvailable,
  isDeprecated,
  type Builtin,
} from "./builtins";
import type { CursorContext, Expected, Expr, Site } from "./cursorContext";
import {
  availableKeywords,
  CONTRACT_KEYWORDS,
  DATA_LOCATION_KEYWORDS,
  EXPRESSION_KEYWORDS,
  FILE_KEYWORDS,
  functionAttributes,
  MAPPING,
  STATEMENT_KEYWORDS,
  stateAttributes,
  type Keyword,
} from "./keywords";
import { DATA_LOCATIONS, type ContractNode, type Decl, type DeclKind, type Param } from "./structure";
import { structureFile, SymbolResolver, type StructureFile, type StructureHost, type Sym, type TypeScope } from "./symbols";
import { canonicalType, elementaryTypeInfo, ELEMENTARY_TYPES, isReferenceType, staticMembers, valueMembers, type ExprType } from "./types";
import { Typer } from "./typing";

export type EntryKind =
  | "keyword"
  | "type"
  | "variable"
  | "parameter"
  | "field"
  | "property"
  | "function"
  | "method"
  | "event"
  | "error"
  | "struct"
  | "enum"
  | "enumMember"
  | "contract"
  | "interface"
  | "library"
  | "modifier"
  | "constant"
  | "unit"
  | "namespace";

/**
 * Groups in which suggestions are listed when VS Code's fuzzy score ties: what fits
 * the expected type first, then the scope, the language and the globals. Auto-import
 * suggestions come after all of them.
 */
export const RANK = {
  match: 0,
  compatible: 1,
  local: 2,
  member: 3,
  keyword: 4,
  global: 5,
} as const;

export interface CompletionEntry {
  readonly label: string;
  readonly kind: EntryKind;
  /** Short text next to the label: a type or a signature. */
  readonly detail?: string;
  /** Markdown. */
  readonly documentation?: string;
  readonly rank: number;
  readonly deprecated?: boolean;
  /** Text to insert instead of the label. */
  readonly insertText?: string;
  /** Snippet syntax to insert instead of the label. */
  readonly snippet?: string;
}

export interface CompletionEnv {
  /** The solc version the file is compiled with (at least 0.8.0). */
  readonly version: string;
  /** Path of the file being edited, to resolve its imports. */
  readonly path?: string;
  /** Other files, for imports and inherited members. Without it only the current file is known. */
  readonly host?: StructureHost;
}

/** Collects entries, the first one of each label winning. */
class Entries {
  readonly list: CompletionEntry[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly env: CompletionEnv) {}

  has(label: string): boolean {
    return this.seen.has(label);
  }

  add(entry: CompletionEntry): void {
    if (this.seen.has(entry.label)) return;
    this.seen.add(entry.label);
    this.list.push(entry);
  }

  keywords(list: readonly Keyword[]): void {
    for (const k of availableKeywords(list, this.env.version)) {
      this.add({ label: k.label, kind: "keyword", rank: RANK.keyword, ...(k.detail ? { detail: k.detail } : {}), ...(k.snippet ? { snippet: k.snippet } : {}) });
    }
  }

  /** Elementary types; `address payable` only where a type is declared (not in conversions). */
  types(options: { payable: boolean }): void {
    for (const t of ELEMENTARY_TYPES) {
      this.add({ label: t, kind: "type", rank: RANK.keyword });
      if (t === "address" && options.payable) this.add({ label: "address payable", kind: "type", rank: RANK.keyword });
    }
  }

  builtins(list: readonly Builtin[], rank: number, asMember: boolean): void {
    for (const b of list) {
      if (!isAvailable(b, this.env.version)) continue;
      this.add(builtinEntry(b, this.env, rank, asMember));
    }
  }
}

export function builtinEntry(b: Builtin, env: CompletionEnv, rank: number, asMember: boolean): CompletionEntry {
  const deprecated = isDeprecated(b, env.version);
  const kind: EntryKind = b.kind === "function" ? (asMember ? "method" : "function") : asMember ? "property" : "variable";
  const detail = b.kind === "function" ? `${b.name}${b.signature ?? "()"}` : b.type || undefined;
  const documentation = deprecated && b.deprecation ? `${b.doc}\n\n**${b.deprecation}**` : b.doc;
  return { label: b.name, kind, rank, documentation, ...(detail ? { detail } : {}), ...(deprecated ? { deprecated } : {}) };
}

/** Suggestions for the cursor, in priority order. */
export async function complete(ctx: CursorContext, env: CompletionEnv): Promise<CompletionEntry[]> {
  if (ctx.site.kind === "none") return [];
  return new Session(ctx, env).run();
}

/** Every name in scope at the cursor: locals, contract members (inherited included), file-level names. */
export async function namesInScope(ctx: CursorContext, env: CompletionEnv): Promise<Set<string>> {
  const session = new Session(ctx, env);
  const names = new Set(ctx.locals.map((d) => d.name));
  for (const sym of await session.scope()) names.add(sym.name);
  return names;
}

/** Declaration kinds that can be used as a type name. */
const TYPE_KINDS = new Set<DeclKind>(["contract", "abstract", "interface", "library", "struct", "enum", "type", "module"]);
/** Declaration kinds whose name is a value in expressions (types are too: conversions, `Enum.X`, `Lib.f`). */
const VALUE_KINDS = new Set<DeclKind>(["stateVariable", "constant", "immutable", "function", ...TYPE_KINDS]);

interface ExpectedValue {
  readonly type?: string;
  readonly name?: string;
}

class Session {
  private readonly out: Entries;
  private readonly file: StructureFile;
  private readonly resolver: SymbolResolver;
  private readonly typer: Typer;
  private readonly at: TypeScope;

  constructor(
    private readonly ctx: CursorContext,
    private readonly env: CompletionEnv,
  ) {
    this.out = new Entries(env);
    this.file = structureFile(env.path ?? "/untitled.sol", ctx.structure.text, ctx.structure);
    const file = this.file;
    const host = env.host;
    // The file being edited is used as typed, not as saved.
    this.resolver = new SymbolResolver({
      load: async (p) => (p === file.path ? file : host?.load(p)),
      resolveImport: (importPath, importer) => host?.resolveImport(importPath, importer) ?? importPath,
    });
    this.at = ctx.contract ? { file, contract: ctx.contract } : { file };
    this.typer = new Typer(this.resolver, this.at, ctx.locals);
  }

  async run(): Promise<CompletionEntry[]> {
    const { out } = this;
    const site = this.ctx.site;
    switch (site.kind) {
      case "none":
        break;
      case "member":
        await this.members(site.receiver);
        break;
      case "unit":
        for (const b of UNITS) out.add({ ...builtinEntry(b, this.env, RANK.keyword, false), kind: "unit" });
        break;
      case "fileLevel":
        out.keywords(FILE_KEYWORDS);
        out.types({ payable: true });
        await this.userTypes(() => true);
        break;
      case "afterAbstract":
        out.keywords([{ label: "contract" }]);
        break;
      case "contractLevel":
        out.keywords(CONTRACT_KEYWORDS);
        out.keywords([MAPPING]);
        out.types({ payable: true });
        await this.userTypes(() => true);
        break;
      case "structField":
        out.keywords([MAPPING]);
        out.types({ payable: true });
        await this.userTypes(() => true);
        break;
      case "afterType":
        this.afterType(site);
        break;
      case "functionAttributes":
        out.keywords(functionAttributes(site.callable, site.used, this.ctx.contract !== undefined));
        for (const sym of await this.scope()) {
          const self = site.callable === "modifier" && this.ctx.callable?.name === sym.name;
          // After the keywords: visibility and mutability come first in a header.
          if (sym.decl.kind === "modifier" && !site.used.includes(sym.name) && !self) out.add(this.symEntry(sym, RANK.keyword));
        }
        break;
      case "typeName":
        await this.typeName(site.purpose);
        break;
      case "statement":
        await this.values(undefined);
        out.keywords(STATEMENT_KEYWORDS);
        out.types({ payable: true });
        out.keywords([MAPPING]);
        await this.userTypes(() => true);
        out.keywords(EXPRESSION_KEYWORDS);
        this.globals();
        break;
      case "expression":
        if (site.keyword) {
          const kind = site.keyword === "emit" ? "event" : "error";
          for (const sym of await this.scope()) if (sym.decl.kind === kind) out.add(this.symEntry(sym, RANK.member));
          break;
        }
        await this.values(await this.expected(site.expected));
        out.types({ payable: false });
        out.keywords(EXPRESSION_KEYWORDS);
        this.globals();
        break;
      case "callOption":
        for (const option of ["value", "gas"]) {
          if (!site.given.includes(option)) out.add({ label: option, kind: "property", detail: "uint256", rank: RANK.member, insertText: `${option}: ` });
        }
        break;
      case "namedArgName":
        await this.namedArgNames(site.callee, site.given);
        break;
    }
    return out.list;
  }

  // ---- scope ---------------------------------------------------------------------

  private scopeCache: Promise<Sym[]> | undefined;

  /** Contract members (own, then inherited), then names visible at file level. */
  scope(): Promise<Sym[]> {
    this.scopeCache ??= (async () => {
      const out: Sym[] = [];
      const seen = new Set<string>();
      if (this.ctx.contract) {
        for (const sym of await this.resolver.members(this.file, this.ctx.contract)) {
          out.push(sym);
          seen.add(sym.name);
        }
      }
      for (const [name, syms] of await this.resolver.fileScope(this.file)) {
        if (seen.has(name)) continue;
        out.push(syms[0]!);
      }
      return out;
    })();
    return this.scopeCache;
  }

  /** Parameters, locals and members usable as values, those fitting `expected` first. */
  private async values(expected: ExpectedValue | undefined): Promise<void> {
    const candidates: Array<{ entry: CompletionEntry; type: string | undefined }> = [];
    for (const d of this.ctx.locals) candidates.push({ entry: this.localEntry(d), type: d.type });
    for (const sym of await this.scope()) {
      if (!VALUE_KINDS.has(sym.decl.kind)) continue;
      // External functions are called through `this`; constructors and fallbacks have no name.
      if (sym.decl.kind === "function" && (sym.decl.visibility === "external" || !sym.name)) continue;
      // An overload is suggested once.
      if (candidates.some((c) => c.entry.label === sym.name)) continue;
      candidates.push({ entry: this.symEntry(sym, RANK.member), type: this.valueTypeOf(sym) });
    }
    if (expected?.type) for (const g of derivedGlobals(expected.type)) candidates.push({ entry: g, type: g.detail });
    const ranked = candidates.map((c) => ({ ...c, entry: { ...c.entry, rank: rankFor(c.entry, c.type, expected) } }));
    // Stable: within a rank, keep scope order (innermost first).
    ranked.sort((a, b) => a.entry.rank - b.entry.rank);
    for (const c of ranked) this.out.add(c.entry);
  }

  /** The type a symbol has as a value (a function: what it returns). */
  private valueTypeOf(sym: Sym): string | undefined {
    if (sym.decl.kind === "function") return sym.decl.returns?.length === 1 ? sym.decl.returns[0]!.type : undefined;
    if (TYPE_KINDS.has(sym.decl.kind)) return undefined;
    return sym.decl.type;
  }

  private async userTypes(filter: (kind: DeclKind) => boolean): Promise<void> {
    for (const sym of await this.scope()) {
      if (TYPE_KINDS.has(sym.decl.kind) && filter(sym.decl.kind)) this.out.add(this.symEntry(sym, RANK.member));
    }
  }

  private async typeName(purpose: Extract<Site, { kind: "typeName" }>["purpose"]): Promise<void> {
    const { out } = this;
    switch (purpose) {
      case "inheritance":
      case "override":
        await this.userTypes((k) => k === "contract" || k === "abstract" || k === "interface" || k === "module");
        return;
      case "using":
        await this.userTypes(() => true);
        out.types({ payable: true });
        return;
      case "new":
        await this.userTypes((k) => k === "contract" || k === "module");
        out.types({ payable: false });
        return;
      case "udvt":
        out.types({ payable: false });
        return;
      case "param":
      case "mapping":
        await this.userTypes((k) => k !== "library");
        out.keywords([MAPPING]);
        out.types({ payable: true });
        return;
    }
  }

  private afterType(site: Extract<Site, { kind: "afterType" }>): void {
    const { out } = this;
    if (site.type === "address" && site.used.length === 0) out.keywords([{ label: "payable" }]);
    switch (site.where) {
      case "state":
      case "file":
        out.keywords(stateAttributes(site.used, site.where === "file"));
        return;
      case "eventParam":
        if (!site.used.includes("indexed")) out.keywords([{ label: "indexed" }]);
        return;
      case "local":
      case "param":
        if (isReferenceType(site.type) && !site.used.some((u) => DATA_LOCATIONS.has(u))) out.keywords(DATA_LOCATION_KEYWORDS);
        return;
    }
  }

  private globals(): void {
    for (const b of GLOBAL_VALUES) this.out.add({ ...builtinEntry(b, this.env, RANK.global, false), kind: b.name === "this" || b.name === "super" ? "keyword" : "namespace" });
    this.out.builtins(GLOBAL_FUNCTIONS, RANK.global, false);
  }

  // ---- named arguments and expected types ------------------------------------------

  /** What a call or struct constructor takes: struct fields, function, event or error parameters. */
  private async calleeParams(callee: Expr): Promise<Param[] | undefined> {
    const type = await this.typer.typeOf(callee);
    if (type?.kind === "static" && type.sym) {
      const decl = type.sym.decl;
      if (decl.kind === "struct") return (decl.members ?? []).map((f) => ({ type: f.type ?? "", name: f.name }));
      if (decl.kind === "event" || decl.kind === "error") return [...(decl.params ?? [])];
      return undefined;
    }
    if (type?.kind === "function") return [...(type.sym.decl.params ?? [])];
    return undefined;
  }

  private async namedArgNames(callee: Expr, given: readonly string[]): Promise<void> {
    const params = await this.calleeParams(callee);
    if (!params) return;
    const rest = this.ctx.structure.text.slice(this.ctx.offset);
    const colonFollows = /^[\w$]*\s*:/.test(rest);
    for (const p of params) {
      if (!p.name || given.includes(p.name)) continue;
      this.out.add({ label: p.name, kind: "field", detail: p.type, rank: RANK.match, ...(colonFollows ? {} : { insertText: `${p.name}: ` }) });
    }
  }

  private async expected(e: Expected | undefined): Promise<ExpectedValue | undefined> {
    if (!e) return undefined;
    switch (e.kind) {
      case "type":
        return { type: e.type, ...(e.name ? { name: e.name } : {}) };
      case "sameAs": {
        const type = await this.typer.typeOf(e.expr);
        const name = e.expr.kind === "name" || e.expr.kind === "member" ? e.expr.name : undefined;
        return { ...(type?.kind === "value" ? { type: type.type } : {}), ...(name ? { name } : {}) };
      }
      case "namedArg": {
        const param = (await this.calleeParams(e.callee))?.find((p) => p.name === e.name);
        return { name: e.name, ...(param?.type ? { type: param.type } : {}) };
      }
      case "arg": {
        const param = (await this.calleeParams(e.callee))?.[e.index];
        return param ? { type: param.type, ...(param.name ? { name: param.name } : {}) } : undefined;
      }
      case "return": {
        const returns = this.ctx.callable?.returns ?? [];
        return returns.length === 1 ? { type: returns[0]!.type ?? "", ...(returns[0]!.name ? { name: returns[0]!.name } : {}) } : undefined;
      }
    }
  }

  // ---- members -----------------------------------------------------------------------

  private async members(receiver: Expr): Promise<void> {
    const type = await this.typer.typeOf(receiver);
    if (!type) return;
    const { out } = this;
    switch (type.kind) {
      case "value": {
        const sym = await this.typer.typeSym(type);
        if (!sym) return this.builtinMembers(type);
        if (sym.decl.kind === "struct") {
          for (const f of sym.decl.members ?? []) out.add({ label: f.name, kind: "field", rank: RANK.member, ...(f.type ? { detail: f.type } : {}) });
          return;
        }
        const node = this.resolver.contractOf(sym);
        if (node) await this.contractMembers(sym.file, node, (d) => isExternallyVisible(d));
        return;
      }
      case "static": {
        const sym = type.sym;
        if (!sym) return this.builtinMembers(type);
        if (sym.module) {
          for (const [name, syms] of await this.resolver.fileScope(sym.module)) out.add({ ...this.symEntry(syms[0]!, RANK.member), label: name });
          return;
        }
        if (sym.decl.kind === "enum") {
          for (const v of sym.decl.members ?? []) out.add({ label: v.name, kind: "enumMember", detail: sym.name, rank: RANK.member });
          return;
        }
        if (sym.decl.kind === "type") {
          const underlying = sym.decl.type ?? "";
          out.add({ label: "wrap", kind: "method", detail: `wrap(${underlying}) returns (${sym.name})`, rank: RANK.member });
          out.add({ label: "unwrap", kind: "method", detail: `unwrap(${sym.name}) returns (${underlying})`, rank: RANK.member });
          return;
        }
        const node = this.resolver.contractOf(sym);
        // `Lib.f`, `C.Struct`, `I.f.selector`, `C.CONSTANT`: everything but private members.
        if (node) await this.contractMembers(sym.file, node, (d) => d.visibility !== "private" && !!d.name);
        return;
      }
      case "this":
        if (this.ctx.contract) await this.contractMembers(this.file, this.ctx.contract, (d) => isExternallyVisible(d));
        return;
      case "super":
        if (!this.ctx.contract) return;
        for (const base of await this.resolver.bases(this.file, this.ctx.contract)) {
          await this.contractMembers(
            base.file,
            base.contract,
            (d) => (d.kind === "function" || d.kind === "stateVariable" || d.kind === "constant") && d.visibility !== "external" && d.visibility !== "private",
          );
        }
        return;
      case "function":
        out.add({ label: "selector", kind: "property", detail: "bytes4", rank: RANK.member });
        if (type.external) out.add({ label: "address", kind: "property", detail: "address", rank: RANK.member });
        return;
      case "typeInfo": {
        if (elementaryTypeInfo(type.of)) return this.builtinMembers(type);
        const sym = await this.resolver.resolvePath(type.at ?? this.at, type.of);
        const kind = sym?.decl.kind;
        if (kind === "interface") out.builtins(INTERFACE_TYPE_INFO, RANK.member, true);
        else if (kind === "contract" || kind === "abstract") out.builtins(CONTRACT_TYPE_INFO, RANK.member, true);
        else if (kind === "enum") out.builtins(ENUM_TYPE_INFO, RANK.member, true);
        else this.builtinMembers(type);
        return;
      }
      case "namespace":
        return this.builtinMembers(type);
    }
  }

  /** Members of a contract (inherited included) accepted by `filter`, as members of a value. */
  private async contractMembers(file: StructureFile, contract: ContractNode, filter: (d: Decl) => boolean): Promise<void> {
    for (const sym of await this.resolver.members(file, contract)) {
      if (!filter(sym.decl)) continue;
      const decl = sym.decl;
      const entry = this.symEntry(sym, RANK.member);
      if (decl.kind === "function") this.out.add({ ...entry, kind: "method" });
      // A public state variable seen from outside is its getter.
      else if (decl.kind === "stateVariable" || decl.kind === "constant" || decl.kind === "immutable") this.out.add({ ...entry, kind: decl.visibility === "public" ? "method" : entry.kind });
      else this.out.add(entry);
    }
  }

  private builtinMembers(type: ExprType): void {
    const { out } = this;
    switch (type.kind) {
      case "namespace":
        out.builtins({ msg: MSG, block: BLOCK, tx: TX, abi: ABI }[type.name], RANK.member, true);
        return;
      case "value":
        out.builtins(valueMembers(type.type), RANK.member, true);
        return;
      case "static":
        out.builtins(staticMembers(type.type), RANK.member, true);
        return;
      case "typeInfo": {
        const elementary = elementaryTypeInfo(type.of);
        if (elementary) out.builtins(elementary, RANK.member, true);
        // Without knowing what X is, offer what any contract, interface or enum may have.
        else out.builtins([...CONTRACT_TYPE_INFO, ...INTERFACE_TYPE_INFO, ...ENUM_TYPE_INFO], RANK.member, true);
        return;
      }
      default:
        return;
    }
  }

  // ---- entries -------------------------------------------------------------------------

  private localEntry(d: Decl): CompletionEntry {
    return { label: d.name, kind: d.kind === "local" ? "variable" : "parameter", rank: RANK.local, ...(d.type ? { detail: d.type } : {}) };
  }

  symEntry(sym: Sym, rank: number): CompletionEntry {
    const decl = sym.decl;
    const origin = sym.owner && sym.owner !== this.ctx.contract ? `Declared in \`${sym.owner.decl.name}\`.` : undefined;
    return {
      label: sym.name,
      kind: ENTRY_KINDS[decl.kind],
      rank,
      ...(detailOf(decl) ? { detail: detailOf(decl) } : {}),
      ...(origin ? { documentation: origin } : {}),
    };
  }
}

const ENTRY_KINDS: Readonly<Record<DeclKind, EntryKind>> = {
  contract: "contract",
  abstract: "contract",
  interface: "interface",
  library: "library",
  struct: "struct",
  enum: "enum",
  event: "event",
  error: "error",
  type: "type",
  function: "function",
  modifier: "modifier",
  stateVariable: "field",
  constant: "constant",
  immutable: "field",
  parameter: "parameter",
  return: "variable",
  local: "variable",
  field: "field",
  enumValue: "enumMember",
  module: "namespace",
};

function detailOf(decl: Decl): string | undefined {
  switch (decl.kind) {
    case "function":
    case "modifier":
    case "event":
    case "error": {
      const params = `(${(decl.params ?? []).map(formatParam).join(", ")})`;
      const returns = decl.returns?.length ? ` returns (${decl.returns.map(formatParam).join(", ")})` : "";
      return `${decl.name}${params}${returns}`;
    }
    case "contract":
    case "interface":
    case "library":
    case "struct":
    case "enum":
      return decl.kind;
    case "abstract":
      return "abstract contract";
    case "type":
      return decl.type ? `type ${decl.name} is ${decl.type}` : "user-defined value type";
    case "module":
      return "unit alias";
    default:
      return decl.type;
  }
}

function formatParam(p: Param): string {
  return [p.type, p.location, p.name].filter(Boolean).join(" ");
}

/** Functions callable and state variables readable from outside the contract. */
function isExternallyVisible(d: Decl): boolean {
  if (d.kind === "function") return d.visibility === "external" || d.visibility === "public";
  return (d.kind === "stateVariable" || d.kind === "constant" || d.kind === "immutable") && d.visibility === "public";
}

/** Rank of a value suggestion given what is expected there. */
function rankFor(entry: CompletionEntry, type: string | undefined, expected: ExpectedValue | undefined): number {
  if (!expected) return entry.rank;
  const typeFits = type !== undefined && expected.type !== undefined ? compatible(type, expected.type) : undefined;
  const nameFits = expected.name !== undefined && sameName(entry.label, expected.name);
  if (nameFits && typeFits !== false) return RANK.match;
  if (typeFits) return RANK.compatible;
  return entry.rank;
}

/** True when a value of type `actual` can be used where `expected` is (implicitly convertible). */
export function compatible(actual: string, expected: string): boolean {
  const a = canonicalType(actual.replace(/\s+(memory|storage|calldata)$/, ""));
  const e = canonicalType(expected.replace(/\s+(memory|storage|calldata)$/, ""));
  if (a === e) return true;
  if (a === "address payable" && e === "address") return true;
  const ints = (t: string) => /^(u?)int(\d+)$/.exec(t);
  const ai = ints(a);
  const ei = ints(e);
  if (ai && ei) return ai[1] === ei[1] && Number(ai[2]) <= Number(ei[2]);
  // User-defined types written with different qualifications (`Lib.Config` and `Config`).
  const last = (t: string) => t.split(".").at(-1);
  return /^[A-Z_$]/i.test(a) && !a.includes("(") && last(a) === last(e);
}

/** `nftAddress_`, `_nftAddress` and `nftAddress` name the same thing. */
export function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/^_+|_+$/g, "").toLowerCase();
  return norm(a) === norm(b) && norm(a) !== "";
}

/** Global expressions of a known type, suggested when that type is expected. */
function derivedGlobals(type: string): CompletionEntry[] {
  const t = canonicalType(type);
  const entry = (label: string, detail: string): CompletionEntry => ({ label, kind: "property", detail, rank: RANK.global });
  if (t === "address") return [entry("msg.sender", "address"), entry("tx.origin", "address"), entry("address(this)", "address")];
  if (t === "uint256") return [entry("block.timestamp", "uint256"), entry("block.number", "uint256"), entry("msg.value", "uint256")];
  return [];
}
