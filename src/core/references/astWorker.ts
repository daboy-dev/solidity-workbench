import { Worker } from "node:worker_threads";
import type { CompilerSettings } from "../compiler/compilerSettings";
import type { InstalledSolc } from "../compiler/solcVersions";
import type { FoundryConfig } from "../project/foundryConfig";
import { ProjectModel } from "../project/projectModel";
import type { RemappingOrigin } from "../project/remappingSource";
import type { Remapping } from "../project/remappings";
import { compileProjectAst, type ProjectAst } from "./projectAst";

/**
 * solc's AST of a large project is tens of megabytes of JSON: parsing and indexing
 * it runs in a worker thread so that the extension host never stalls. solc itself
 * runs in its own process, started from the worker.
 */

export interface ProjectData {
  readonly root: string;
  readonly config: FoundryConfig;
  readonly remappings: readonly Remapping[];
  readonly remappingOrigin: RemappingOrigin;
  readonly hasFoundryToml: boolean;
  readonly forgeStatus: string;
  readonly compiler: CompilerSettings;
}

export type AstWorkerRequest =
  | {
      readonly id: number;
      readonly kind: "compile";
      readonly project: ProjectData;
      readonly sources: ReadonlyArray<readonly [string, string]>;
      readonly installed: readonly InstalledSolc[];
      readonly configured?: string;
    }
  | { readonly id: number; readonly kind: "cancel" };

export type AstWorkerResponse = { readonly id: number; readonly ast: ProjectAst } | { readonly id: number; readonly error: string; readonly aborted: boolean };

export function projectData(p: ProjectModel): ProjectData {
  return {
    root: p.root,
    config: p.config,
    remappings: p.remappings,
    remappingOrigin: p.remappingOrigin,
    hasFoundryToml: p.hasFoundryToml,
    forgeStatus: p.forgeStatus,
    compiler: p.compiler,
  };
}

export function projectFromData(d: ProjectData): ProjectModel {
  return new ProjectModel(d.root, d.config, d.remappings, d.remappingOrigin, d.hasFoundryToml, d.forgeStatus, d.compiler);
}

const controllers = new Map<number, AbortController>();

/** Handles one request inside the worker. */
export async function handleAstRequest(req: AstWorkerRequest, post: (r: AstWorkerResponse) => void): Promise<void> {
  if (req.kind === "cancel") {
    controllers.get(req.id)?.abort();
    return;
  }
  const controller = new AbortController();
  controllers.set(req.id, controller);
  try {
    const ast = await compileProjectAst({
      project: projectFromData(req.project),
      sources: new Map(req.sources),
      installed: req.installed,
      ...(req.configured ? { configured: req.configured } : {}),
      signal: controller.signal,
    });
    post({ id: req.id, ast });
  } catch (err) {
    post({ id: req.id, error: err instanceof Error ? err.message : String(err), aborted: controller.signal.aborted });
  } finally {
    controllers.delete(req.id);
  }
}

export class AbortedError extends Error {
  override readonly name = "AbortError";
}

export interface CompileJob {
  readonly promise: Promise<ProjectAst>;
  cancel(): void;
}

/** Runs compilations in one worker thread, started on demand and stopped when idle. */
export class AstWorkerClient {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (ast: ProjectAst) => void; reject: (err: Error) => void }>();
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly workerScript: string,
    private readonly idleMs = 120_000,
  ) {}

  compile(project: ProjectModel, sources: ReadonlyMap<string, string>, installed: readonly InstalledSolc[], configured: string | undefined): CompileJob {
    const id = this.nextId++;
    const worker = this.ensureWorker();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const promise = new Promise<ProjectAst>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const req: AstWorkerRequest = { id, kind: "compile", project: projectData(project), sources: [...sources], installed, ...(configured ? { configured } : {}) };
      worker.postMessage(req);
    });
    return { promise, cancel: () => this.worker?.postMessage({ id, kind: "cancel" } satisfies AstWorkerRequest) };
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerScript);
    worker.unref();
    worker.on("message", (res: AstWorkerResponse) => {
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      if ("ast" in res) p.resolve(res.ast);
      else p.reject(res.aborted ? new AbortedError(res.error) : new Error(res.error));
      if (this.pending.size === 0) this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    });
    const fail = (err: Error) => {
      if (this.worker !== worker) return;
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker = undefined;
    };
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`The solc worker stopped (exit code ${code}).`)));
    this.worker = worker;
    return worker;
  }

  private stop(): void {
    const w = this.worker;
    this.worker = undefined;
    void w?.terminate();
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.stop();
  }
}
