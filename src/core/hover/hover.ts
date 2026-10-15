import { ABI, BLOCK, CONTRACT_TYPE_INFO, ENUM_TYPE_INFO, EXTERNAL_FUNCTION, GLOBAL_FUNCTIONS, GLOBAL_VALUES, INTERFACE_TYPE_INFO, MSG, TX, UNITS, type Builtin } from "../completion/builtins";
import { overloadsCalledAt } from "../completion/calls";
import { cursorContext, type CursorContext } from "../completion/cursorContext";
import { declarationsNamed, fromSym, memberDecls, type MemberDecl } from "../completion/members";
import type { ContractNode, Decl, SourceStructure } from "../completion/structure";
import { structureFile, SymbolResolver, type StructureFile, type StructureHost } from "../completion/symbols";
import type { Token } from "../completion/tokens";
import { Typer } from "../completion/typing";
import { elementaryTypeInfo, isElementaryType, staticMembers, valueMembers, type ExprType } from "../completion/types";
import { localSymbolAt, type LocalSymbol } from "../references/locals";
import { declarationAt, declarationStart, signatureOf } from "./declarations";
import { builtinSection, elementaryTypeSection, unitSection } from "./format";
import { docCommentBefore, parseNatSpec, renderNatSpec, type NatSpec } from "./natspec";

/** One block of a hover: a Solidity code line and its documentation (Markdown). */
export interface HoverSection {
  readonly code: string;
  readonly doc?: string;
}

export interface HoverResult {
  /** The hovered name. */
  readonly start: number;
  readonly end: number;
  readonly sections: readonly HoverSection[];
}

export interface HoverEnv {
  /** The solc version the file is compiled with (at least 0.8.0). */
  readonly version: string;
  /** Path of the file being edited, to resolve its imports. */
  readonly path?: string;
  /** Other files, for imports and inherited members. Without it only the current file is known. */
  readonly host?: StructureHost;
}

const NAMESPACES: Readonly<Record<"msg" | "block" | "tx" | "abi", readonly Builtin[]>> = { msg: MSG, block: BLOCK, tx: TX, abi: ABI };

/** Where solc's AST says the name at an offset of the edited file is declared, when it is at hand. */
export type AstLookup = (offset: number) => { readonly path: string; readonly nameStart: number } | undefined;

/**
 * What to show when hovering the name at `offset`, with the tolerant parser only
 * (never solc): locals and parameters, project declarations with their signature and
 * NatSpec (members of values, inherited and imported ones included), and built-in
 * globals and members (`msg.sender`, `abi.encode`, `keccak256`, `addr.balance`,
 * `type(uint8).max`, `1 ether`) from the version-aware catalog. `ast` answers what the
 * parser cannot type (`x.f()` through `using for`...). Undefined in comments, strings
 * and on anything unknown.
 */
export async function hoverAt(structure: SourceStructure, offset: number, env: HoverEnv & { readonly ast?: AstLookup }): Promise<HoverResult | undefined> {
  const k = tokenAt(structure.tokens, offset);
  if (k < 0) return undefined;
  const token = structure.tokens[k]!;
  const name = token.text;
  const result = (sections: readonly HoverSection[] | undefined): HoverResult | undefined =>
    sections?.length ? { start: token.start, end: token.end, sections } : undefined;

  const local = localSymbolAt(structure, token.start);
  if (local) return result([localSection(structure, local)]);
  const ctx = cursorContext(structure, token.start);
  const typer = typerFor(ctx, env);
  const file = typer.at.file;
  const own = declarationAt(file, token.start);
  if (own) return result([await declarationSection(own, ctx.contract, typer.resolver)]);
  if (ctx.site.kind === "none") return undefined;

  if (ctx.site.kind === "unit") {
    const unit = UNITS.find((u) => u.name === name);
    return result(unit && [unitSection(unit)]);
  }
  const sectionsOf = (decls: readonly MemberDecl[]) => Promise.all(decls.map((d) => declarationSection(d, ctx.contract, typer.resolver)));
  let sections: readonly HoverSection[] | undefined;
  if (ctx.site.kind === "member") {
    const decls = await memberDecls(typer, ctx.site.receiver, name);
    sections = decls.length ? await sectionsOf(await overloadsCalledAt(typer, structure, k, decls)) : await builtinMember(typer, await typer.typeOf(ctx.site.receiver), name, env.version);
  } else {
    const decls = await declarationsNamed(typer, name);
    sections = decls.length ? await sectionsOf(await overloadsCalledAt(typer, structure, k, decls)) : builtinName(ctx, name, env.version) ?? typeName(structure, k);
  }
  if (sections?.length) return result(sections);

  const target = env.ast?.(token.start);
  const targetFile = target && (await typer.resolver.load(target.path));
  const found = targetFile && declarationAt(targetFile, target.nameStart);
  return result(found ? await sectionsOf([found]) : undefined);
}

/** A local variable or parameter, with its `@param` / `@return` text. */
function localSection(structure: SourceStructure, local: LocalSymbol): HoverSection {
  const code = [local.decl.type, local.decl.location, local.decl.name].filter(Boolean).join(" ");
  const c = local.callable;
  if (!c || (local.decl.kind !== "parameter" && local.decl.kind !== "return")) return { code };
  const comment = docCommentBefore(structure, c.start);
  if (!comment) return { code };
  const spec = parseNatSpec(comment, c.returns.map((r) => r.name));
  const text =
    local.decl.kind === "parameter"
      ? spec.params.find((p) => p.name === local.decl.name)?.text
      : (spec.returns.find((r) => r.name === local.decl.name) ?? spec.returns[c.returns.findIndex((r) => r.nameStart === local.decl.nameStart)])?.text;
  return text ? { code, doc: text } : { code };
}

/** A project declaration: its signature, NatSpec, and where it comes from when not from the contract being edited. */
async function declarationSection(ref: MemberDecl, contract: ContractNode | undefined, resolver: SymbolResolver): Promise<HoverSection> {
  const code = signatureOf(ref);
  const notes: string[] = [];
  const spec = await natSpecOf(ref, resolver, 0);
  const doc = spec && renderNatSpec(spec);
  if (doc) notes.push(doc);
  if (ref.owner && ref.owner !== contract) notes.push(`*Declared in \`${ref.owner.decl.name}\` (${basename(ref.file.path)}).*`);
  return notes.length ? { code, doc: notes.join("\n\n") } : { code };
}

const MAX_INHERITANCE = 8;

/**
 * A declaration's NatSpec. As solc does, a function without NatSpec takes the documentation
 * of the function it overrides, and `@inheritdoc Base` takes Base's, then adds its own tags.
 */
async function natSpecOf(ref: MemberDecl, resolver: SymbolResolver, depth: number): Promise<NatSpec | undefined> {
  const comment = docCommentBefore(ref.file.structure, declarationStart(ref));
  const own = comment ? parseNatSpec(comment, ref.decl.returns?.map((r) => r.name ?? "") ?? []) : undefined;
  if (ref.decl.kind !== "function" || !ref.owner || depth > MAX_INHERITANCE || (own && !own.inheritdoc)) return own;
  const base = await overridden(ref, ref.owner, resolver, own?.inheritdoc);
  const inherited = base && (await natSpecOf(base, resolver, depth + 1));
  return own ? mergeNatSpec(inherited, own) : inherited;
}

/** The function `ref` overrides: in contract `baseName` (or its bases), or in the nearest base that has one. */
async function overridden(ref: MemberDecl, owner: ContractNode, resolver: SymbolResolver, baseName: string | undefined): Promise<MemberDecl | undefined> {
  const params = paramTypes(ref.decl);
  const match = async (file: StructureFile, contract: ContractNode) => {
    const sym = (await resolver.members(file, contract)).find((s) => s.name === ref.decl.name && s.decl.kind === "function" && paramTypes(s.decl) === params);
    return sym && fromSym(sym);
  };
  if (baseName) {
    const sym = await resolver.resolvePath({ file: ref.file, contract: owner }, baseName, false);
    const node = sym && resolver.contractOf(sym);
    return sym && node ? match(sym.file, node) : undefined;
  }
  for (const base of await resolver.bases(ref.file, owner)) {
    const found = await match(base.file, base.contract);
    if (found) return found;
  }
  return undefined;
}

function paramTypes(decl: Decl): string {
  return (decl.params ?? []).map((p) => p.type).join(",");
}

/** `own` on top of `base`: own tags win, parameters and returns are taken from the base when not redocumented. */
function mergeNatSpec(base: NatSpec | undefined, own: NatSpec): NatSpec {
  if (!base) return own;
  const { inheritdoc: _, ...rest } = own;
  return {
    ...base,
    ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))),
    params: [...own.params, ...base.params.filter((p) => !own.params.some((o) => o.name === p.name))],
    returns: own.returns.length ? own.returns : base.returns,
    custom: [...base.custom, ...own.custom],
  };
}

function basename(p: string): string {
  return p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
}

/** The identifier token under `offset` (its end included, as editors report the position after a word). */
function tokenAt(tokens: readonly Token[], offset: number): number {
  let lo = 0;
  let hi = tokens.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = tokens[mid]!;
    if (t.end < offset) lo = mid + 1;
    else if (t.start > offset) hi = mid - 1;
    else {
      // Between two adjacent tokens (`a.b`), prefer the identifier.
      if (t.kind === "ident") return mid;
      const next = tokens[mid + 1];
      if (next?.kind === "ident" && next.start === offset) return mid + 1;
      const prev = tokens[mid - 1];
      if (prev?.kind === "ident" && prev.end === offset) return mid - 1;
      return -1;
    }
  }
  return -1;
}

function typerFor(ctx: CursorContext, env: HoverEnv): Typer {
  const file = structureFile(env.path ?? "/untitled.sol", ctx.structure.text, ctx.structure);
  const host = env.host;
  // The file being edited is used as typed, not as saved.
  const resolver = new SymbolResolver({
    load: async (p) => (p === file.path ? file : host?.load(p)),
    resolveImport: (importPath, importer) => host?.resolveImport(importPath, importer) ?? importPath,
  });
  return new Typer(resolver, ctx.contract ? { file, contract: ctx.contract } : { file }, ctx.locals);
}

/** A global name not shadowed by a local: `msg`, `this`, `keccak256`... */
function builtinName(ctx: CursorContext, name: string, version: string): HoverSection[] | undefined {
  if (ctx.locals.some((d) => d.name === name)) return undefined;
  const global = GLOBAL_FUNCTIONS.find((b) => b.name === name) ?? GLOBAL_VALUES.find((b) => b.name === name);
  return global && [builtinSection(global, version)];
}

/** An elementary type name: `uint8`, `bytes32`, `address payable`. */
function typeName(structure: SourceStructure, k: number): HoverSection[] | undefined {
  const name = structure.tokens[k]!.text;
  if (!isElementaryType(name)) return undefined;
  const payable = name === "address" && structure.tokens[k + 1]?.text === "payable";
  const section = elementaryTypeSection(payable ? "address payable" : name);
  return section && [section];
}

/** `object.name` for a built-in member of what `object` is. */
async function builtinMember(typer: Typer, object: ExprType | undefined, name: string, version: string): Promise<HoverSection[] | undefined> {
  if (!object) return undefined;
  const pick = (list: readonly Builtin[], owner: string) => {
    const b = list.find((m) => m.name === name);
    return b && [builtinSection(b, version, owner)];
  };
  switch (object.kind) {
    case "namespace":
      return pick(NAMESPACES[object.name], object.name);
    case "value":
      // User-defined types have no built-in members.
      if (await typer.typeSym(object)) return undefined;
      return pick(valueMembers(object.type), object.type);
    case "static":
      return object.sym ? undefined : pick(staticMembers(object.type), object.type);
    case "function":
      return pick(object.external ? EXTERNAL_FUNCTION : EXTERNAL_FUNCTION.filter((b) => b.name === "selector"), "function");
    case "typeInfo": {
      const owner = `type(${object.of})`;
      const elementary = elementaryTypeInfo(object.of);
      if (elementary) return pick(elementary, owner);
      const kind = (await typer.resolver.resolvePath(object.at ?? typer.at, object.of))?.decl.kind;
      if (kind === "interface") return pick(INTERFACE_TYPE_INFO, owner);
      if (kind === "contract" || kind === "abstract") return pick(CONTRACT_TYPE_INFO, owner);
      if (kind === "enum") return pick(ENUM_TYPE_INFO.map((b) => ({ ...b, type: object.of })), owner);
      return undefined;
    }
    default:
      return undefined;
  }
}
