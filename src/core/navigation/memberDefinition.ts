import { cursorContext, type Expr } from "../completion/cursorContext";
import type { ContractNode, Decl, SourceStructure } from "../completion/structure";
import { isContractKind, structureFile, SymbolResolver, type StructureFile, type StructureHost, type Sym } from "../completion/symbols";
import { Typer } from "../completion/typing";

/** The declaration of a member accessed on a value or a type: `token.transfer`, `listing.price`, `Side.Long`. */
export interface MemberTarget {
  readonly path: string;
  readonly text: string;
  readonly name: string;
  readonly nameStart: number;
}

/** A member declaration with where it lives. */
export interface MemberDecl {
  readonly decl: Decl;
  readonly file: StructureFile;
  /** The contract declaring it, for contract members. */
  readonly owner?: ContractNode;
  /** The struct or enum declaring it, for fields and enum values. */
  readonly parent?: Decl;
}

/**
 * Resolves `object.member` at `offset` with the tolerant parser and the completion
 * typer: struct fields, contract and interface members (inherited ones included),
 * library and unit-alias members, enum values, `this.f` and `super.f`.
 * Undefined when the cursor is not on a member or its object cannot be typed.
 */
export async function memberDefinition(structure: SourceStructure, offset: number, path: string, host: StructureHost): Promise<MemberTarget | undefined> {
  const { tokens } = structure;
  const k = tokens.findIndex((t) => t.start <= offset && offset <= t.end && t.kind === "ident");
  if (k <= 0 || tokens[k - 1]!.text !== ".") return undefined;
  const ctx = cursorContext(structure, tokens[k]!.start);
  if (ctx.site.kind !== "member") return undefined;

  const file = structureFile(path, structure.text, structure);
  // The file being edited is used as typed, not as saved.
  const resolver = new SymbolResolver({ load: async (p) => (p === path ? file : host.load(p)), resolveImport: (i, importer) => host.resolveImport(i, importer) });
  const typer = new Typer(resolver, ctx.contract ? { file, contract: ctx.contract } : { file }, ctx.locals);
  const [found] = await memberDecls(typer, ctx.site.receiver, tokens[k]!.text);
  return found && { path: found.file.path, text: found.file.structure.text, name: found.decl.name, nameStart: found.decl.nameStart };
}

/**
 * The declarations `receiver.name` may refer to, as seen from the typer's scope:
 * one, or every overload of a function (the most derived first).
 */
export async function memberDecls(typer: Typer, receiver: Expr, name: string): Promise<MemberDecl[]> {
  const { resolver, at } = typer;
  const type = await typer.typeOf(receiver);
  const named = async (owner: Sym): Promise<MemberDecl[]> => {
    const node = resolver.contractOf(owner);
    if (!node) {
      const member = await resolver.memberNamed(owner, name);
      return member ? [fromSym(member)] : [];
    }
    return withoutOverridden((await resolver.members(owner.file, node)).filter((s) => s.name === name));
  };
  const field = (owner: Sym): MemberDecl[] => {
    const decl = owner.decl.members?.find((m) => m.name === name);
    return decl ? [{ decl, file: owner.file, parent: owner.decl }] : [];
  };

  switch (type?.kind) {
    case "value": {
      const sym = await typer.typeSym(type);
      if (!sym) return [];
      if (sym.decl.kind === "struct") return field(sym);
      return isContractKind(sym.decl.kind) ? named(sym) : [];
    }
    case "static": {
      const owner = type.sym;
      if (!owner) return [];
      return owner.decl.kind === "enum" ? field(owner) : named(owner);
    }
    case "this":
      if (!at.contract) return [];
      return withoutOverridden((await resolver.members(at.file, at.contract)).filter((s) => s.name === name));
    case "super": {
      if (!at.contract) return [];
      for (const base of await resolver.bases(at.file, at.contract)) {
        const members = (await resolver.members(base.file, base.contract)).filter((s) => s.name === name);
        if (members.length) return withoutOverridden(members);
      }
      return [];
    }
    default:
      return [];
  }
}

/**
 * Members of the same name, most derived first, without the base functions they
 * override (same parameter types): what a call can reach.
 */
export function withoutOverridden(syms: readonly Sym[]): MemberDecl[] {
  const seen = new Set<string>();
  const out: MemberDecl[] = [];
  for (const sym of syms) {
    const key = sym.decl.kind === "function" ? (sym.decl.params ?? []).map((p) => p.type).join(",") : `#${out.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fromSym(sym));
  }
  return out;
}

export function fromSym(sym: Sym): MemberDecl {
  return sym.owner ? { decl: sym.decl, file: sym.file, owner: sym.owner } : { decl: sym.decl, file: sym.file };
}
