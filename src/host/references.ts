import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { AbortedError, AstWorkerClient } from "../core/references/astWorker";
import { listOwnFiles, type ProjectAst } from "../core/references/projectAst";
import { configuredSolc, installedSolc } from "./solc";
import type { ProjectHandle } from "./workbenchCore";

/** The own files of a project as they are now (open buffers win over the disk). */
export interface SourceSnapshot {
  readonly sources: ReadonlyMap<string, string>;
  readonly fingerprint: string;
}

interface CacheEntry {
  readonly fingerprint: string;
  readonly snapshot: SourceSnapshot;
  readonly promise: Promise<ProjectAst>;
  cancel(): void;
}

/**
 * solc's AST of each project, compiled in a worker on demand and kept while
 * no file changes. A request for newer contents cancels a stale compilation.
 */
export class ReferenceService implements vscode.Disposable {
  private readonly client: AstWorkerClient;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly disk = new Map<string, { stamp: string; text: string }>();

  constructor(workerScript: string) {
    this.client = new AstWorkerClient(workerScript);
  }

  async snapshot(project: ProjectHandle): Promise<SourceSnapshot> {
    const open = new Map<string, vscode.TextDocument>();
    for (const d of vscode.workspace.textDocuments) if (d.uri.scheme === "file") open.set(d.uri.fsPath, d);
    const files = await listOwnFiles(project.model);
    const sources = new Map<string, string>();
    const parts: string[] = [configuredSolc(vscode.Uri.file(project.model.root)) ?? project.model.compiler.solc ?? ""];
    for (const f of files) {
      const doc = open.get(f);
      if (doc) {
        sources.set(f, doc.getText());
        parts.push(`${f}@v${doc.version}${doc.isDirty ? "*" : ""}`);
        continue;
      }
      try {
        const st = await fs.stat(f);
        const stamp = `${st.mtimeMs}:${st.size}`;
        let hit = this.disk.get(f);
        if (!hit || hit.stamp !== stamp) this.disk.set(f, (hit = { stamp, text: await fs.readFile(f, "utf8") }));
        sources.set(f, hit.text);
        parts.push(`${f}@${stamp}`);
      } catch {
        // Deleted meanwhile.
      }
    }
    return { sources, fingerprint: parts.join("\n") };
  }

  /** The AST of the project as it is now, from the cache when nothing changed. */
  async ast(project: ProjectHandle): Promise<{ ast: ProjectAst; snapshot: SourceSnapshot }> {
    for (let attempt = 0; ; attempt++) {
      const snapshot = await this.snapshot(project);
      const root = project.model.root;
      let entry = this.cache.get(root);
      if (!entry || entry.fingerprint !== snapshot.fingerprint) {
        entry?.cancel();
        const job = this.client.compile(project.model, snapshot.sources, await installedSolc(), configuredSolc(vscode.Uri.file(root)) ?? project.model.compiler.solc);
        entry = { fingerprint: snapshot.fingerprint, snapshot, promise: job.promise, cancel: job.cancel };
        this.cache.set(root, entry);
        job.promise.catch(() => {
          if (this.cache.get(root) === entry) this.cache.delete(root);
        });
      }
      try {
        return { ast: await entry.promise, snapshot: entry.snapshot };
      } catch (err) {
        // Cancelled by a newer request: wait for that one instead.
        if (!(err instanceof AbortedError) || attempt >= 3) throw err;
      }
    }
  }

  /** Compiles modified contents, without caching (to check a rename). */
  async compile(project: ProjectHandle, sources: ReadonlyMap<string, string>): Promise<ProjectAst> {
    const root = vscode.Uri.file(project.model.root);
    return this.client.compile(project.model, sources, await installedSolc(), configuredSolc(root) ?? project.model.compiler.solc).promise;
  }

  dispose(): void {
    for (const e of this.cache.values()) e.cancel();
    this.cache.clear();
    this.client.dispose();
  }
}
