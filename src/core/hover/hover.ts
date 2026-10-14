import { ABI, BLOCK, CONTRACT_TYPE_INFO, ENUM_TYPE_INFO, EXTERNAL_FUNCTION, GLOBAL_FUNCTIONS, GLOBAL_VALUES, INTERFACE_TYPE_INFO, MSG, TX, UNITS, type Builtin } from "../completion/builtins";
import { cursorContext, type CursorContext } from "../completion/cursorContext";
import type { SourceStructure } from "../completion/structure";
import { structureFile, SymbolResolver, type StructureHost } from "../completion/symbols";
import type { Token } from "../completion/tokens";
import { Typer } from "../completion/typing";
import { elementaryTypeInfo, staticMembers, valueMembers, type ExprType } from "../completion/types";
import { builtinSection, unitSection } from "./format";

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

/**
 * What to show when hovering the name at `offset`, with the tolerant parser only
 * (never solc): built-in globals and members (`msg.sender`, `abi.encode`, `keccak256`,
 * `addr.balance`, `type(uint8).max`, `1 ether`) from the version-aware catalog.
 * Undefined in comments, strings, assembly and on anything it does not know.
 */
export async function hoverAt(structure: SourceStructure, offset: number, env: HoverEnv): Promise<HoverResult | undefined> {
  const k = tokenAt(structure.tokens, offset);
  if (k < 0) return undefined;
  const token = structure.tokens[k]!;
  const ctx = cursorContext(structure, token.start);
  if (ctx.site.kind === "none") return undefined;
  const result = (sections: readonly HoverSection[] | undefined): HoverResult | undefined =>
    sections?.length ? { start: token.start, end: token.end, sections } : undefined;

  if (ctx.site.kind === "unit") {
    const unit = UNITS.find((u) => u.name === token.text);
    return result(unit && [unitSection(unit)]);
  }
  const typer = typerFor(ctx, env);
  if (ctx.site.kind === "member") {
    const receiver = await typer.typeOf(ctx.site.receiver);
    return result(await builtinMember(typer, receiver, token.text, env.version));
  }
  return result(builtinName(ctx, token.text, env.version));
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
