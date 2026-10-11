import * as fs from "node:fs/promises";
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
 * Parses in a worker thread so that indexing large lib/ folders never blocks
 * the extension host. If the worker dies, pending and future requests fall
 * back to inline parsing.
 */
export class WorkerFileParser implements FileParser {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { paths: readonly string[]; resolve: (r: ParsedFile[]) => void }>();
  private readonly fallback = new InlineFileParser();

  constructor(
    private workerScript: string,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  parse(paths: readonly string[]): Promise<ParsedFile[]> {
    const worker = this.ensureWorker();
    if (!worker) return this.fallback.parse(paths);
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, { paths, resolve });
      worker.postMessage({ id, paths } satisfies WorkerRequest);
    });
  }

  dispose(): void {
    const worker = this.worker;
    this.worker = undefined;
    void worker?.terminate();
    this.flushToFallback();
  }

  private ensureWorker(): Worker | undefined {
    if (this.worker) return this.worker;
    if (this.workerScript === "") return undefined;
    try {
      const worker = new Worker(this.workerScript);
      worker.unref();
      worker.on("message", (msg: WorkerResponse) => {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        entry.resolve(msg.results);
      });
      worker.on("error", (err: Error) => {
        this.onError(`Index worker failed: ${err.message}`);
        this.disableWorker();
      });
      worker.on("exit", (code) => {
        if (this.worker === worker && code !== 0) {
          this.onError(`Index worker exited with code ${code}`);
          this.disableWorker();
        }
      });
      this.worker = worker;
      return worker;
    } catch (err) {
      this.onError(`Could not start index worker: ${err instanceof Error ? err.message : String(err)}`);
      this.disableWorker();
      return undefined;
    }
  }

  private disableWorker(): void {
    this.worker = undefined;
    this.workerScript = "";
    this.flushToFallback();
  }

  private flushToFallback(): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const e of entries) void this.fallback.parse(e.paths).then(e.resolve);
  }
}
