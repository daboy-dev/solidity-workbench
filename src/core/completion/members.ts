import type { Expr } from "./cursorContext";
import type { ContractNode, Decl } from "./structure";
import { isContractKind, type StructureFile, type Sym } from "./symbols";
import type { Typer } from "./typing";

/** A member declaration with where it lives. */
export interface MemberDecl {
  readonly decl: Decl;
  readonly file: StructureFile;
  /** The contract declaring it, for contract members. */
  readonly owner?: ContractNode;
  /** The struct or enum declaring it, for fields and enum values. */
  readonly parent?: Decl;
  /** Attached with `using ... for`: called on a value that is its first argument. */
  readonly bound?: boolean;
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
      const own = !sym ? [] : sym.decl.kind === "struct" ? field(sym) : isContractKind(sym.decl.kind) ? await named(sym) : [];
      if (own.length) return own;
      return withoutOverridden(await typer.attached(type, name)).map((d) => ({ ...d, bound: true }));
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

/** What `name` refers to as an expression or type: members of the enclosing contract first, then file level. */
export async function declarationsNamed(typer: Typer, name: string): Promise<MemberDecl[]> {
  const { resolver, at } = typer;
  if (at.contract) {
    const members = (await resolver.members(at.file, at.contract)).filter((s) => s.name === name);
    if (members.length) return withoutOverridden(members);
  }
  return ((await resolver.fileScope(at.file)).get(name) ?? []).map(fromSym);
}

/** The symbol of a member declaration. */
export function toSym(d: MemberDecl): Sym {
  return { name: d.decl.name, decl: d.decl, file: d.file, ...(d.owner ? { owner: d.owner } : {}) };
}
