import type { ProjectArea } from "../project/projectModel";
import type { ExtractionMethod, SymbolDeclaration } from "../solidity/symbols";

export interface IndexedFile {
  /** Absolute path inside the project. */
  readonly path: string;
  readonly realPath: string;
  readonly area: ProjectArea;
  readonly mtimeMs: number;
  readonly size: number;
  readonly method: ExtractionMethod;
  readonly symbols: readonly SymbolDeclaration[];
}

export interface IndexedSymbol extends SymbolDeclaration {
  readonly file: IndexedFile;
}

/** In-memory symbol table of one project, updated file by file. */
export class SymbolIndex {
  private readonly files = new Map<string, IndexedFile>();
  private readonly byName = new Map<string, IndexedSymbol[]>();
  private symbolTotal = 0;
  /** Increases on every change; lets consumers cache derived data. */
  version = 0;

  get fileCount(): number {
    return this.files.size;
  }

  get symbolCount(): number {
    return this.symbolTotal;
  }

  getFile(path: string): IndexedFile | undefined {
    return this.files.get(path);
  }

  allFiles(): IterableIterator<IndexedFile> {
    return this.files.values();
  }

  names(): IterableIterator<string> {
    return this.byName.keys();
  }

  lookup(name: string): readonly IndexedSymbol[] {
    return this.byName.get(name) ?? [];
  }

  *allSymbols(): IterableIterator<IndexedSymbol> {
    for (const list of this.byName.values()) yield* list;
  }

  setFile(file: IndexedFile): void {
    this.removeFile(file.path);
    this.files.set(file.path, file);
    for (const decl of file.symbols) {
      const symbol: IndexedSymbol = { ...decl, file };
      const list = this.byName.get(decl.name);
      if (list) list.push(symbol);
      else this.byName.set(decl.name, [symbol]);
    }
    this.symbolTotal += file.symbols.length;
    this.version++;
  }

  removeFile(path: string): boolean {
    const existing = this.files.get(path);
    if (!existing) return false;
    this.files.delete(path);
    for (const decl of existing.symbols) {
      const list = this.byName.get(decl.name);
      if (!list) continue;
      const remaining = list.filter((s) => s.file !== existing);
      if (remaining.length) this.byName.set(decl.name, remaining);
      else this.byName.delete(decl.name);
    }
    this.symbolTotal -= existing.symbols.length;
    this.version++;
    return true;
  }

  /** Removes every file at or below `pathPrefix` (used for directory deletions). */
  removeUnder(pathPrefix: string, sep = "/"): number {
    const prefix = pathPrefix.endsWith(sep) ? pathPrefix : pathPrefix + sep;
    let removed = 0;
    for (const p of [...this.files.keys()]) {
      if (p === pathPrefix || p.startsWith(prefix)) {
        this.removeFile(p);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.files.clear();
    this.byName.clear();
    this.symbolTotal = 0;
    this.version++;
  }
}
