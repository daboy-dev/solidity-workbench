import * as fs from "node:fs/promises";
import * as os from "node:os";
import { Worker } from "node:worker_threads";
import { extractSymbols } from "../solidity/extractSymbols";
import type { ExtractionMethod, SymbolDeclaration } from "../solidity/symbols";

export interface ParsedFile {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly method: ExtractionMethod;
  readonly symbols: SymbolDeclaration[];
  /** Set when the file could not be read; such files are not indexed. */
  readonly error?: string;
}

/** Parses files into symbol lists. Implementations may run off the main thread. */
export interface FileParser {
  /** How many batches can usefully be parsed at the same time. */
  readonly concurrency?: number;
  parse(paths: readonly string[]): Promise<ParsedFile[]>;
  dispose(): void;
}

export async function parseFile(path: string): Promise<ParsedFile> {
  try {
    const [st, text] = await Promise.all([fs.stat(path), fs.readFile(path, "utf8")]);
    const { symbols, method } = extractSymbols(text);
    return { path, mtimeMs: st.mtimeMs, size: st.size, method, symbols };
  } catch (err) {
    return { path, mtimeMs: 0, size: 0, method: "regex", symbols: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Parses on the calling thread. Used in tests and as a fallback. */
export class InlineFileParser implements FileParser {
  async parse(paths: readonly string[]): Promise<ParsedFile[]> {
    const out: ParsedFile[] = [];
    for (const p of paths) {
      out.push(await parseFile(p));
      // Yield between files so a long batch never monopolizes the event loop.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return out;
  }

  dispose(): void {}
}

export interface WorkerRequest {
  readonly id: number;
  readonly paths: readonly string[];
}

export interface WorkerResponse {
  readonly id: number;
  readonly results: ParsedFile[];
}

/**
 * Parses in a pool of worker threads so that indexing large lib/ folders
 * never blocks the extension host and uses several cores. Workers are
 * stopped when idle. If a worker cannot start or dies, pending and future
 * requests fall back to inline parsing.
 */
export class WorkerFileParser implements FileParser {
  readonly concurrency: number;
  private readonly workers: Worker[] = [];
  private readonly load = new Map<Worker, number>();
  private nextId = 1;
  private readonly pending = new Map<number, { paths: readonly string[]; resolve: (r: ParsedFile[]) => void }>();
  private readonly fallback = new InlineFileParser();
  private idleTimer: NodeJS.Timeout | undefined;
  private broken = false;

  constructor(
    private readonly workerScript: string,
    private readonly onError: (message: string) => void = () => {},
    poolSize = Math.max(1, Math.min(4, os.availableParallelism() - 1)),
    private readonly idleMs = 30_000,
  ) {
    this.concurrency = poolSize;
  }

  parse(paths: readonly string[]): Promise<ParsedFile[]> {
    const worker = this.pickWorker();
    if (!worker) return this.fallback.parse(paths);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const id = this.nextId++;
    this.load.set(worker, (this.load.get(worker) ?? 0) + 1);
    return new Promise((resolve) => {
      this.pending.set(id, { paths, resolve });
      worker.postMessage({ id, paths } satisfies WorkerRequest);
    });
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.stopWorkers();
    this.flushToFallback();
  }

  /** The least busy worker, starting a new one while the pool is not full. */
  private pickWorker(): Worker | undefined {
    if (this.broken) return undefined;
    let best: Worker | undefined;
    for (const w of this.workers) if (!best || this.load.get(w)! < this.load.get(best)!) best = w;
    if (best && (this.load.get(best) === 0 || this.workers.length >= this.concurrency)) return best;
    return this.startWorker() ?? best;
  }

  private startWorker(): Worker | undefined {
    try {
      const worker = new Worker(this.workerScript);
      worker.unref();
      worker.on("message", (msg: WorkerResponse) => {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        this.load.set(worker, Math.max(0, (this.load.get(worker) ?? 1) - 1));
        entry.resolve(msg.results);
        if (this.pending.size === 0) this.scheduleIdleStop();
      });
      worker.on("error", (err: Error) => this.fail(`Index worker failed: ${err.message}`));
      worker.on("exit", (code) => {
        if (this.workers.includes(worker) && code !== 0) this.fail(`Index worker exited with code ${code}`);
      });
      this.workers.push(worker);
      this.load.set(worker, 0);
      return worker;
    } catch (err) {
      this.broken = true;
      this.onError(`Could not start index worker: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** A failing worker disables the pool: the cause (e.g. a missing script) would affect every worker. */
  private fail(message: string): void {
    this.onError(message);
    this.broken = true;
    this.stopWorkers();
    this.flushToFallback();
  }

  private scheduleIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) this.stopWorkers();
    }, this.idleMs);
    this.idleTimer.unref();
  }

  private stopWorkers(): void {
    const workers = this.workers.splice(0);
    this.load.clear();
    for (const w of workers) void w.terminate();
  }

  private flushToFallback(): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const e of entries) void this.fallback.parse(e.paths).then(e.resolve);
  }
}
