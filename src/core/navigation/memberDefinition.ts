import { calleeCandidates, overloadsCalledAt } from "../completion/calls";
import { cursorContext, type CursorContext } from "../completion/cursorContext";
import { memberDecls, type MemberDecl } from "../completion/members";
import type { SourceStructure } from "../completion/structure";
import { structureFile, SymbolResolver, type StructureHost } from "../completion/symbols";
import { Typer } from "../completion/typing";

export { fromSym, memberDecls, withoutOverridden, type MemberDecl } from "../completion/members";

/** The declaration of a member accessed on a value or a type: `token.transfer`, `listing.price`, `Side.Long`. */
export interface MemberTarget {
  readonly path: string;
  readonly text: string;
  readonly name: string;
  readonly nameStart: number;
}

/**
 * Resolves `object.member` at `offset` with the tolerant parser and the completion
 * typer: struct fields, contract and interface members (inherited ones included),
 * library and unit-alias members, enum values, `this.f`, `super.f` and functions
 * attached with `using ... for`. Of overloaded functions, those the call's arguments
 * can reach. Empty when the cursor is not on a member or its object cannot be typed.
 */
export async function memberDefinitions(structure: SourceStructure, offset: number, path: string, host: StructureHost): Promise<MemberTarget[]> {
  const k = identAt(structure, offset);
  if (k <= 0 || structure.tokens[k - 1]!.text !== ".") return [];
  const ctx = cursorContext(structure, structure.tokens[k]!.start);
  if (ctx.site.kind !== "member") return [];
  const typer = typerAt(structure, ctx, path, host);
  const decls = await memberDecls(typer, ctx.site.receiver, structure.tokens[k]!.text);
  return (await overloadsCalledAt(typer, structure, k, decls)).map(toTarget);
}

/** The first of `memberDefinitions`. */
export async function memberDefinition(structure: SourceStructure, offset: number, path: string, host: StructureHost): Promise<MemberTarget | undefined> {
  return (await memberDefinitions(structure, offset, path, host))[0];
}

/**
 * For an overloaded function, event or error called by name at `offset` (`f(x)`), the
 * overloads its arguments can reach. Empty when it is not such a call or every overload fits.
 */
export async function calledOverloads(structure: SourceStructure, offset: number, path: string, host: StructureHost): Promise<MemberTarget[]> {
  const k = identAt(structure, offset);
  if (k < 0 || structure.tokens[k - 1]?.text === "." || structure.tokens[k + 1]?.text !== "(") return [];
  const ctx = cursorContext(structure, structure.tokens[k]!.start);
  if (ctx.site.kind === "none") return [];
  const typer = typerAt(structure, ctx, path, host);
  const decls = await calleeCandidates(typer, { kind: "name", name: structure.tokens[k]!.text });
  const reached = await overloadsCalledAt(typer, structure, k, decls);
  return reached.length < decls.length ? reached.map(toTarget) : [];
}

function identAt(structure: SourceStructure, offset: number): number {
  return structure.tokens.findIndex((t) => t.start <= offset && offset <= t.end && t.kind === "ident");
}

function typerAt(structure: SourceStructure, ctx: CursorContext, path: string, host: StructureHost): Typer {
  const file = structureFile(path, structure.text, structure);
  // The file being edited is used as typed, not as saved.
  const resolver = new SymbolResolver({ load: async (p) => (p === path ? file : host.load(p)), resolveImport: (i, importer) => host.resolveImport(i, importer) });
  return new Typer(resolver, ctx.contract ? { file, contract: ctx.contract } : { file }, ctx.locals);
}

function toTarget(d: MemberDecl): MemberTarget {
  return { path: d.file.path, text: d.file.structure.text, name: d.decl.name, nameStart: d.decl.nameStart };
}
