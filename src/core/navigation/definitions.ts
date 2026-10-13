import type { DocumentAnalysis } from "../solidity/analyzeDocument";
import type { OutlineNode } from "../solidity/documentOutline";
import { analyzeFile, type FileAnalysis, type ImportStatement } from "../solidity/fileAnalysis";
import { blankTrivia, isInCommentOrString } from "../solidity/lexContext";

/** A Solidity file as seen by navigation: its text, outline and imports. */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
  readonly analysis: DocumentAnalysis;
  readonly imports: FileAnalysis;
}

/** Access to files and import resolution, provided by the host (open buffers win over disk). */
export interface SourceHost {
  load(path: string): Promise<SourceFile | undefined>;
  resolveImport(importPath: string, importer: string): string;
}

export interface DefinitionTarget {
  readonly path: string;
  /** Whole declaration, UTF-16 offsets in the target file's text. */
  readonly start: number;
  readonly end: number;
  /** The declared name. Equal to start/end for a whole-file target. */
  readonly nameStart: number;
  readonly nameEnd: number;
  /** Text of the target file, so the host can convert offsets without reloading it. */
  readonly text: string;
}

const CONTRACT_KINDS = new Set(["contract", "abstract", "interface", "library"]);
const MAX_DEPTH = 8;
const IDENT_CHAR = /[A-Za-z0-9_$]/;

export function sourceFile(path: string, text: string, analysis: DocumentAnalysis): SourceFile {
  return { path, text, analysis, imports: analyzeFile(text) };
}

/**
 * Finds where the symbol at `offset` is declared. Handles import paths,
 * names declared in the file, members of the enclosing contract and of its
 * bases, imported names (aliases, plain imports, re-exports) and qualified
 * names (`Lib.f`, `Contract.Struct`, `Alias.Symbol`, `super.f`).
 * Local variables and members of values (`token.transfer`) are not resolved.
 */
export async function findDefinitions(host: SourceHost, file: SourceFile, offset: number): Promise<DefinitionTarget[]> {
  const imp = importPathAt(file.imports.imports, file.text, offset);
  if (imp) {
    const target = await host.load(host.resolveImport(imp.path, file.path));
    return target ? [wholeFile(target)] : [];
  }
  if (isInCommentOrString(file.imports.trivia, offset)) return [];

  const word = wordAt(file.text, offset);
  if (!word) return [];
  const resolver = new Resolver(host);

  const qualifiers = qualifiersBefore(file.text, word.start);
  // `token.safeTransfer(...)`: the receiver is a value we cannot type, but the function may come
  // from a library attached with `using ... for`.
  if (qualifiers === null) return resolver.viaUsingFor(file, offset, word.name);
  if (qualifiers.length > 0) {
    const [head, ...rest] = qualifiers as [string, ...string[]];
    if (head === "super" || head === "this") {
      const contract = enclosingContract(file.analysis.outline, offset);
      if (!contract || rest.length > 0) return [];
      return head === "this"
        ? resolver.members(file, contract, word.name, new Set())
        : resolver.inheritedMembers(file, contract, word.name, new Set());
    }
    let owners = await resolver.resolveName(file, head, offset);
    for (const part of [...rest, word.name]) owners = await resolver.memberOf(owners, part);
    if (owners.length === 0) return resolver.viaUsingFor(file, offset, word.name);
    return owners.map((f) => (f.node ? toTarget(f.file, f.node) : wholeFile(f.file)));
  }

  const found = await resolver.resolveName(file, word.name, offset);
  return found.map((f) => (f.node ? toTarget(f.file, f.node) : wholeFile(f.file)));
}

interface Found {
  readonly file: SourceFile;
  /** Undefined when the name refers to a whole file (a unit alias). */
  readonly node: OutlineNode | undefined;
}

class Resolver {
  constructor(private readonly host: SourceHost) {}

  /** Resolves an unqualified name as seen from `offset` in `file`. */
  async resolveName(file: SourceFile, name: string, offset: number): Promise<Found[]> {
    const contract = enclosingContract(file.analysis.outline, offset);
    if (contract && contract.name !== name) {
      const members = await this.membersFound(file, contract, name, new Set());
      if (members.length) return members;
    }
    return this.topLevelFound(file, name, new Set(), 0);
  }

  /**
   * Functions attached with `using Lib for T;` or `using {f, Lib.g} for T;` in the enclosing
   * contract or at file level (directives are not inherited by derived contracts).
   */
  async viaUsingFor(file: SourceFile, offset: number, name: string): Promise<DefinitionTarget[]> {
    const contract = enclosingContract(file.analysis.outline, offset);
    const clean = blankTrivia(file.text, file.imports.trivia);
    // A directive applies when it is at file level, or inside the contract we are in.
    const applies = (at: number) => {
      const owner = enclosingContract(file.analysis.outline, at);
      return owner === undefined || owner === contract;
    };
    const found: Found[] = [];
    for (const m of clean.matchAll(/\busing\s+(\{[^}]*\}|[A-Za-z_$][\w$.]*)\s+for\b/g)) {
      if (!applies(m.index ?? 0)) continue;
      const target = m[1]!;
      if (target.startsWith("{")) {
        // `using {add, Lib.sub as -} for T`: only the listed functions are attached.
        for (const item of target.slice(1, -1).split(",")) {
          const fn = item.trim().split(/\s+as\s+/)[0]!.trim();
          if (fn.split(".").at(-1) !== name) continue;
          const parts = fn.split(".");
          let owners = await this.resolveName(file, parts[0]!, offset);
          for (const part of parts.slice(1)) owners = await this.memberOf(owners, part);
          found.push(...owners);
        }
      } else {
        const parts = target.split(".");
        let owners = await this.resolveName(file, parts[0]!, offset);
        for (const part of parts.slice(1)) owners = await this.memberOf(owners, part);
        found.push(...(await this.memberOf(owners.filter((o) => o.node?.kind === "library"), name)));
      }
    }
    return found.filter((f) => f.node).map((f) => toTarget(f.file, f.node!));
  }

  /** `name` looked up inside each owner: a file (unit alias), a contract, library, interface or enum. */
  async memberOf(owners: readonly Found[], name: string): Promise<Found[]> {
    const out: Found[] = [];
    for (const owner of owners) {
      if (owner.node === undefined) out.push(...(await this.topLevelFound(owner.file, name, new Set(), 0)));
      else if (CONTRACT_KINDS.has(owner.node.kind) || owner.node.kind === "enum") {
        out.push(...(await this.membersFound(owner.file, owner.node, name, new Set())));
      }
    }
    return out;
  }

  /** A name visible at file level: declared in the file or brought in by its imports. */
  private async topLevelFound(file: SourceFile, name: string, visited: Set<string>, depth: number): Promise<Found[]> {
    if (depth > MAX_DEPTH || visited.has(file.path)) return [];
    visited.add(file.path);
    const own = file.analysis.outline.filter((n) => n.name === name);
    if (own.length) return own.map((node) => ({ file, node }));

    for (const imp of file.imports.imports) {
      if (imp.kind === "unitAlias" && imp.unitAlias === name) {
        const target = await this.load(imp, file);
        return target ? [{ file: target, node: undefined }] : [];
      }
      if (imp.kind === "named") {
        const symbol = imp.symbols.find((s) => (s.alias ?? s.name) === name);
        if (!symbol) continue;
        const target = await this.load(imp, file);
        return target ? this.topLevelFound(target, symbol.name, visited, depth + 1) : [];
      }
    }
    // `import "x.sol";` brings every global name of x (including its own imports) into scope.
    for (const imp of file.imports.imports) {
      if (imp.kind !== "plain") continue;
      const target = await this.load(imp, file);
      if (!target) continue;
      const found = await this.topLevelFound(target, name, visited, depth + 1);
      if (found.length) return found;
    }
    return [];
  }

  async members(file: SourceFile, contract: OutlineNode, name: string, visited: Set<string>): Promise<DefinitionTarget[]> {
    return (await this.membersFound(file, contract, name, visited)).map((f) => toTarget(f.file, f.node!));
  }

  async inheritedMembers(file: SourceFile, contract: OutlineNode, name: string, visited: Set<string>): Promise<DefinitionTarget[]> {
    const out: Found[] = [];
    for (const base of await this.bases(file, contract)) out.push(...(await this.membersFound(base.file, base.node!, name, visited)));
    return out.map((f) => toTarget(f.file, f.node!));
  }

  /** Members named `name` (all overloads) of a contract, else of its bases, nearest first. */
  private async membersFound(file: SourceFile, contract: OutlineNode, name: string, visited: Set<string>): Promise<Found[]> {
    const key = `${file.path}#${contract.start}`;
    if (visited.has(key) || visited.size > 64) return [];
    visited.add(key);
    const own = contract.children.filter((c) => c.name === name);
    if (own.length) return own.map((node) => ({ file, node }));
    const out: Found[] = [];
    for (const base of await this.bases(file, contract)) {
      const found = await this.membersFound(base.file, base.node!, name, visited);
      // Keep the first base that declares it; later bases are overridden in the linearization.
      if (found.length) {
        out.push(...found);
        break;
      }
    }
    return out;
  }

  /** Resolves `contract.bases`, rightmost first (the most derived in solc's linearization). */
  private async bases(file: SourceFile, contract: OutlineNode): Promise<Found[]> {
    const out: Found[] = [];
    for (const base of [...(contract.bases ?? [])].reverse()) {
      const parts = base.split(".");
      let found = await this.topLevelFound(file, parts[0]!, new Set(), 0);
      for (const part of parts.slice(1)) found = await this.memberOf(found, part);
      out.push(...found.filter((f) => f.node && CONTRACT_KINDS.has(f.node.kind)));
    }
    return out;
  }

  private async load(imp: ImportStatement, from: SourceFile): Promise<SourceFile | undefined> {
    return this.host.load(this.host.resolveImport(imp.path, from.path));
  }
}

function enclosingContract(outline: readonly OutlineNode[], offset: number): OutlineNode | undefined {
  return outline.find((n) => CONTRACT_KINDS.has(n.kind) && offset >= n.start && offset < n.end);
}

function toTarget(file: SourceFile, node: OutlineNode): DefinitionTarget {
  return { path: file.path, start: node.start, end: node.end, nameStart: node.nameStart, nameEnd: node.nameEnd, text: file.text };
}

function wholeFile(file: SourceFile): DefinitionTarget {
  return { path: file.path, start: 0, end: 0, nameStart: 0, nameEnd: 0, text: file.text };
}

/** The import whose path string contains `offset`, if any. */
export function importPathAt(imports: readonly ImportStatement[], text: string, offset: number): ImportStatement | undefined {
  return imports.find((imp) => {
    const range = importPathRange(imp, text);
    return range !== undefined && offset >= range.start && offset <= range.end;
  });
}

/** Range of the path inside the quotes of an import statement. */
export function importPathRange(imp: ImportStatement, text: string): { start: number; end: number } | undefined {
  const quoted = `${imp.quote}${imp.path}${imp.quote}`;
  const at = text.indexOf(quoted, imp.start);
  if (at < 0 || at > imp.end) return undefined;
  return { start: at + 1, end: at + 1 + imp.path.length };
}

function wordAt(text: string, offset: number): { name: string; start: number } | undefined {
  let start = offset;
  while (start > 0 && IDENT_CHAR.test(text[start - 1]!)) start--;
  let end = offset;
  while (end < text.length && IDENT_CHAR.test(text[end]!)) end++;
  const name = text.slice(start, end);
  return /^[A-Za-z_$]/.test(name) ? { name, start } : undefined;
}

/**
 * The qualifiers of the name starting at `start`: `["T", "Side"]` for
 * `T.Side.Long`. Empty when the name is not qualified; null when it is
 * qualified by an expression we cannot resolve without types (`f().x`, `a[0].x`).
 */
function qualifiersBefore(text: string, start: number): string[] | null {
  const chain: string[] = [];
  let i = start;
  for (;;) {
    while (i > 0 && /\s/.test(text[i - 1]!)) i--;
    if (text[i - 1] !== ".") return chain;
    i--;
    while (i > 0 && /\s/.test(text[i - 1]!)) i--;
    const end = i;
    while (i > 0 && IDENT_CHAR.test(text[i - 1]!)) i--;
    const name = text.slice(i, end);
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
    chain.unshift(name);
  }
}
