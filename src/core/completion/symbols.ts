import { analyzeFile, type FileAnalysis } from "../solidity/fileAnalysis";
import { parseStructure, type ContractNode, type Decl, type SourceStructure } from "./structure";

/** A file as completion sees it. */
export interface StructureFile {
  readonly path: string;
  readonly structure: SourceStructure;
  readonly imports: FileAnalysis;
}

/** Access to other files (open buffers win over the disk) and import resolution. */
export interface StructureHost {
  load(path: string): Promise<StructureFile | undefined>;
  resolveImport(importPath: string, importer: string): string;
}

export function structureFile(path: string, text: string, structure: SourceStructure = parseStructure(text)): StructureFile {
  return { path, structure, imports: analyzeFile(text) };
}

/** A declaration as visible from somewhere. */
export interface Sym {
  /** The name it is visible under (an import alias may rename it). */
  readonly name: string;
  readonly decl: Decl;
  /** The file declaring it. */
  readonly file: StructureFile;
  /** The contract declaring it, for members. */
  readonly owner?: ContractNode;
  /** The aliased file, for unit aliases. */
  readonly module?: StructureFile;
}

/** Where a type name was written, to resolve it as its author saw it. */
export interface TypeScope {
  readonly file: StructureFile;
  readonly contract?: ContractNode;
}

const CONTRACT_KINDS = new Set(["contract", "abstract", "interface", "library"]);
const MAX_DEPTH = 8;

export function isContractKind(kind: string): boolean {
  return CONTRACT_KINDS.has(kind);
}

/**
 * Resolves names for completion: what a file sees at file level (its own
 * declarations and imports, including aliases, plain and re-exported imports)
 * and the members of contracts with those inherited from their bases.
 */
export class SymbolResolver {
  private readonly scopes = new Map<string, Map<string, Sym[]>>();
  private readonly memberCache = new Map<string, Sym[]>();

  constructor(private readonly host: StructureHost) {}

  load(path: string): Promise<StructureFile | undefined> {
    return this.host.load(path);
  }

  /** Every name visible at file level in `file`, own declarations first. */
  async fileScope(file: StructureFile): Promise<ReadonlyMap<string, readonly Sym[]>> {
    return (await this.scopeOf(file, new Set(), 0)).scope;
  }

  private async scopeOf(file: StructureFile, visiting: Set<string>, depth: number): Promise<{ scope: Map<string, Sym[]>; complete: boolean }> {
    const cached = this.scopes.get(file.path);
    if (cached) return { scope: cached, complete: true };
    const scope = new Map<string, Sym[]>();
    const add = (name: string, sym: Sym) => {
      const list = scope.get(name);
      if (!list) scope.set(name, [sym]);
      else if (!list.some((s) => s.decl === sym.decl)) list.push(sym);
    };
    for (const decl of file.structure.fileDecls) if (decl.name) add(decl.name, { name: decl.name, decl, file });
    let complete = true;
    if (visiting.has(file.path) || depth > MAX_DEPTH) return { scope, complete: false };
    visiting.add(file.path);
    for (const imp of file.imports.imports) {
      const target = await this.host.load(this.host.resolveImport(imp.path, file.path));
      if (!target) continue;
      if (imp.kind === "unitAlias" && imp.unitAlias) {
        add(imp.unitAlias, { name: imp.unitAlias, decl: { name: imp.unitAlias, kind: "module", nameStart: imp.start, visibleFrom: 0 }, file, module: target });
        continue;
      }
      const inner = await this.scopeOf(target, visiting, depth + 1);
      complete &&= inner.complete;
      if (imp.kind === "named") {
        for (const s of imp.symbols) for (const sym of inner.scope.get(s.name) ?? []) add(s.alias ?? s.name, { ...sym, name: s.alias ?? s.name });
      } else {
        // `import "x.sol";` brings every global name of x into scope, its own imports included.
        for (const [name, syms] of inner.scope) if (!scope.has(name)) for (const sym of syms) add(name, sym);
      }
    }
    visiting.delete(file.path);
    // A scope cut short by an import cycle is incomplete: do not reuse it.
    if (complete) this.scopes.set(file.path, scope);
    return { scope, complete };
  }

  /** The contract node a contract-like symbol declares. */
  contractOf(sym: Sym): ContractNode | undefined {
    if (!isContractKind(sym.decl.kind)) return undefined;
    return sym.file.structure.contracts.find((c) => c.decl === sym.decl);
  }

  /**
   * Members of a contract, own first, then inherited from its bases in an order close to
   * solc's linearization (the most derived first). Private members of bases are left out,
   * and a name declared in a more derived contract hides the same name further up
   * (function overloads excepted).
   */
  async members(file: StructureFile, contract: ContractNode): Promise<readonly Sym[]> {
    const key = `${file.path}#${contract.start}`;
    const cached = this.memberCache.get(key);
    if (cached) return cached;
    const out: Sym[] = [];
    const seen = new Set<string>();
    const visit = async (f: StructureFile, c: ContractNode, own: boolean, depth: number) => {
      const k = `${f.path}#${c.start}`;
      if (seen.has(k) || depth > MAX_DEPTH * 2) return;
      seen.add(k);
      const declaredHere = new Set<string>();
      for (const decl of c.members) {
        if (!decl.name || (!own && decl.visibility === "private")) continue;
        const hidden = out.some((s) => s.name === decl.name && !(s.decl.kind === "function" && decl.kind === "function"));
        if (hidden && !declaredHere.has(decl.name)) continue;
        declaredHere.add(decl.name);
        out.push({ name: decl.name, decl, file: f, owner: c });
      }
      for (const base of await this.bases(f, c)) await visit(base.file, base.contract, false, depth + 1);
    };
    await visit(file, contract, true, 0);
    this.memberCache.set(key, out);
    return out;
  }

  /** Resolved base contracts, rightmost (most derived) first. */
  async bases(file: StructureFile, contract: ContractNode): Promise<Array<{ file: StructureFile; contract: ContractNode }>> {
    const out: Array<{ file: StructureFile; contract: ContractNode }> = [];
    for (const base of [...(contract.decl.bases ?? [])].reverse()) {
      const sym = await this.resolvePath({ file }, base, false);
      const node = sym && this.contractOf(sym);
      if (sym && node) out.push({ file: sym.file, contract: node });
    }
    return out;
  }

  /**
   * Resolves a (possibly qualified) name as seen from `at`: `Listing`, `Lib.Config`,
   * `Alias.Token`. With `members`, names of the enclosing contract and its bases come first.
   */
  async resolvePath(at: TypeScope, path: string, members = true): Promise<Sym | undefined> {
    const [head, ...rest] = path.split(".");
    let sym = await this.resolveName(at, head!, members);
    for (const part of rest) {
      if (!sym) return undefined;
      sym = await this.memberNamed(sym, part);
    }
    return sym;
  }

  async resolveName(at: TypeScope, name: string, members = true): Promise<Sym | undefined> {
    if (members && at.contract) {
      const found = (await this.members(at.file, at.contract)).find((s) => s.name === name);
      if (found) return found;
    }
    return (await this.fileScope(at.file)).get(name)?.[0];
  }

  /** `X.name` for a unit alias, contract, library or interface X. */
  async memberNamed(owner: Sym, name: string): Promise<Sym | undefined> {
    if (owner.module) return (await this.fileScope(owner.module)).get(name)?.[0];
    const node = this.contractOf(owner);
    if (!node) return undefined;
    return (await this.members(owner.file, node)).find((s) => s.name === name);
  }

  /** The scope in which a symbol's own type names were written. */
  declScope(sym: Sym): TypeScope {
    return sym.owner ? { file: sym.file, contract: sym.owner } : { file: sym.file };
  }
}
