import { cursorContext } from "../completion/cursorContext";
import type { Decl, SourceStructure } from "../completion/structure";
import { isContractKind, structureFile, SymbolResolver, type StructureFile, type StructureHost } from "../completion/symbols";
import { Typer } from "../completion/typing";

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
 * library and unit-alias members, enum values, `this.f` and `super.f`.
 * Undefined when the cursor is not on a member or its object cannot be typed.
 */
export async function memberDefinition(structure: SourceStructure, offset: number, path: string, host: StructureHost): Promise<MemberTarget | undefined> {
  const { tokens } = structure;
  const k = tokens.findIndex((t) => t.start <= offset && offset <= t.end && t.kind === "ident");
  if (k <= 0 || tokens[k - 1]!.text !== ".") return undefined;
  const name = tokens[k]!.text;
  const ctx = cursorContext(structure, tokens[k]!.start);
  if (ctx.site.kind !== "member") return undefined;

  const file = structureFile(path, structure.text, structure);
  // The file being edited is used as typed, not as saved.
  const resolver = new SymbolResolver({ load: async (p) => (p === path ? file : host.load(p)), resolveImport: (i, importer) => host.resolveImport(i, importer) });
  const at = ctx.contract ? { file, contract: ctx.contract } : { file };
  const typer = new Typer(resolver, at, ctx.locals);
  const type = await typer.typeOf(ctx.site.receiver);
  const found = (f: StructureFile, decl: Decl | undefined): MemberTarget | undefined =>
    decl ? { path: f.path, text: f.structure.text, name: decl.name, nameStart: decl.nameStart } : undefined;

  switch (type?.kind) {
    case "value": {
      const sym = await typer.typeSym(type);
      if (!sym) return undefined;
      if (sym.decl.kind === "struct") return found(sym.file, sym.decl.members?.find((f) => f.name === name));
      if (!isContractKind(sym.decl.kind)) return undefined;
      const member = await resolver.memberNamed(sym, name);
      return member && found(member.file, member.decl);
    }
    case "static": {
      const owner = type.sym;
      if (!owner) return undefined;
      if (owner.decl.kind === "enum") return found(owner.file, owner.decl.members?.find((m) => m.name === name));
      const member = await resolver.memberNamed(owner, name);
      return member && found(member.file, member.decl);
    }
    case "this": {
      if (!ctx.contract) return undefined;
      const member = (await resolver.members(file, ctx.contract)).find((s) => s.name === name);
      return member && found(member.file, member.decl);
    }
    case "super": {
      if (!ctx.contract) return undefined;
      for (const base of await resolver.bases(file, ctx.contract)) {
        const member = (await resolver.members(base.file, base.contract)).find((s) => s.name === name);
        if (member) return found(member.file, member.decl);
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
