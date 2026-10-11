import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProjectModel } from "../project/projectModel";
import type { FileParser, ParsedFile } from "./fileParser";
import { readIndexCache, writeIndexCache } from "./indexCache";
import { createFileFilter, scanProject, type IndexScope, type ScannedFile } from "./scanner";
import { SymbolIndex, type IndexedFile } from "./symbolIndex";

export interface IndexStats {
  readonly files: number;
  readonly symbols: number;
  readonly fromCache: number;
  readonly parsed: number;
  readonly regexFallbacks: number;
  readonly durationMs: number;
}

export interface IndexerOptions {
  readonly parser: FileParser;
  /** Where to persist the cache. No caching when undefined. */
  readonly cacheFile?: string;
  readonly batchSize?: number;
  readonly log?: (message: string) => void;
}

export interface CancellationFlag {
  readonly isCancellationRequested: boolean;
}

/**
 * Builds and maintains the {@link SymbolIndex} of one project: initial build
 * from the disk cache plus a scan, and incremental updates for single files.
 */
export class ProjectIndexer {
  readonly index = new SymbolIndex();
  private readonly isIncluded: (absPath: string) => boolean;
  private readonly batchSize: number;
  private saveTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    readonly project: ProjectModel,
    readonly scope: IndexScope,
    private readonly options: IndexerOptions,
  ) {
    this.isIncluded = createFileFilter(project, scope);
    this.batchSize = options.batchSize ?? 64;
  }

  /** True when the file would be indexed under the current project and scope. */
  includes(absPath: string): boolean {
    return this.isIncluded(absPath);
  }

  async build(token?: CancellationFlag): Promise<IndexStats> {
    const started = Date.now();
    const cached = this.options.cacheFile ? await readIndexCache(this.options.cacheFile, this.project.root) : new Map<string, IndexedFile>();
    const scanned = await scanProject(this.project, this.scope);

    const toParse: ScannedFile[] = [];
    let fromCache = 0;
    for (const file of scanned) {
      if (token?.isCancellationRequested) break;
      const hit = cached.get(file.path);
      if (hit && (await isUnchanged(file.path, hit))) {
        this.index.setFile({ ...hit, realPath: file.realPath, area: file.area });
        fromCache++;
      } else {
        toParse.push(file);
      }
    }

    let regexFallbacks = 0;
    for (let i = 0; i < toParse.length && !token?.isCancellationRequested && !this.disposed; i += this.batchSize) {
      const batch = toParse.slice(i, i + this.batchSize);
      const results = await this.options.parser.parse(batch.map((f) => f.path));
      results.forEach((r, j) => {
        if (this.applyParsed(r, batch[j]!) && r.method !== "parser") regexFallbacks++;
      });
    }

    if (toParse.length > 0 || fromCache !== cached.size) this.scheduleCacheSave(0);
    const stats: IndexStats = {
      files: this.index.fileCount,
      symbols: this.index.symbolCount,
      fromCache,
      parsed: toParse.length,
      regexFallbacks,
      durationMs: Date.now() - started,
    };
    this.options.log?.(
      `Indexed ${stats.files} files (${stats.symbols} symbols) in ${this.project.root}: ` +
        `${stats.fromCache} from cache, ${stats.parsed} parsed, ${stats.regexFallbacks} with regex fallback, ${stats.durationMs} ms`,
    );
    return stats;
  }

  /** Re-indexes created or changed files. Files no longer included are dropped. */
  async updateFiles(paths: readonly string[]): Promise<void> {
    const toParse: ScannedFile[] = [];
    for (const p of paths) {
      if (!this.isIncluded(p)) {
        this.index.removeFile(p);
        continue;
      }
      const existing = this.index.getFile(p);
      if (existing && (await isUnchanged(p, existing))) continue;
      let realPath = p;
      try {
        realPath = await fs.realpath(p);
      } catch {
        this.index.removeFile(p);
        continue;
      }
      toParse.push({ path: p, realPath, area: this.project.areaOf(p) });
    }
    if (toParse.length === 0) return;
    const results = await this.options.parser.parse(toParse.map((f) => f.path));
    results.forEach((r, i) => this.applyParsed(r, toParse[i]!));
    this.scheduleCacheSave();
  }

  /** Drops deleted files or every file below a deleted directory. */
  removePath(absPath: string): void {
    const removed = this.index.removeFile(absPath) ? 1 : this.index.removeUnder(absPath, path.sep);
    if (removed > 0) this.scheduleCacheSave();
  }

  /** Indexes a newly created directory (e.g. `forge install`), which watchers report as a single event. */
  async addDirectory(absDir: string): Promise<void> {
    const files: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 20) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.name.startsWith(".")) await walk(full, depth + 1);
        else if (e.isFile() && this.isIncluded(full)) files.push(full);
      }
    };
    await walk(absDir, 0);
    for (let i = 0; i < files.length; i += this.batchSize) await this.updateFiles(files.slice(i, i + this.batchSize));
  }

  async flushCache(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.options.cacheFile) return;
    try {
      await writeIndexCache(this.options.cacheFile, this.project.root, this.index.allFiles());
    } catch (err) {
      this.options.log?.(`Could not write index cache: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      void this.flushCache();
    }
  }

  private applyParsed(r: ParsedFile, file: ScannedFile): boolean {
    if (r.error) {
      this.index.removeFile(file.path);
      return false;
    }
    this.index.setFile({
      path: file.path,
      realPath: file.realPath,
      area: file.area,
      mtimeMs: r.mtimeMs,
      size: r.size,
      method: r.method,
      symbols: r.symbols,
    });
    return true;
  }

  private scheduleCacheSave(delayMs = 2_000): void {
    if (!this.options.cacheFile || this.disposed) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flushCache(), delayMs);
  }
}

async function isUnchanged(absPath: string, entry: IndexedFile): Promise<boolean> {
  try {
    const st = await fs.stat(absPath);
    return st.mtimeMs === entry.mtimeMs && st.size === entry.size;
  } catch {
    return false;
  }
}
