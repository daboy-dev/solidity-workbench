import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { FileParser } from "../core/index/fileParser";
import { cacheFileName } from "../core/index/indexCache";
import { ProjectIndexer } from "../core/index/projectIndexer";
import type { SymbolIndex } from "../core/index/symbolIndex";
import { findProjectRoot, loadProject, type ProjectModel } from "../core/project/projectModel";
import { formatRemapping } from "../core/project/remappings";
import { DocumentAnalysisService, type AnalyzedDocument, type AnalyzedFile } from "./documentAnalysis";
import type { Logger } from "./logger";
import { affectsCore, readCoreSettings } from "./settings";

/** A loaded project and its index, as seen by features. */
export interface ProjectHandle {
  readonly model: ProjectModel;
  readonly index: SymbolIndex;
  /** True until the first full build completes; the index may be partial meanwhile. */
  readonly indexing: boolean;
  /** Resolves when the first full build completes. */
  readonly ready: Promise<void>;
}

/**
 * The shared, feature-agnostic core: discovers Foundry projects, keeps their
 * symbol indexes up to date and exposes them to features.
 */
export interface WorkbenchCore {
  readonly log: Logger;
  /** Fires when a project's index changes (initial build or incremental update). */
  readonly onDidChangeIndex: vscode.Event<ProjectHandle>;
  /** The project a document belongs to, loading and indexing it on first use. */
  projectFor(uri: vscode.Uri): Promise<ProjectHandle | undefined>;
  /** Outline and syntax problems of an open document, computed off the main thread. */
  analyzeDocument(document: vscode.TextDocument): Promise<AnalyzedDocument>;
  /** Same for a file as saved on disk (cached by modification time). */
  analyzeFile(path: string): Promise<AnalyzedFile | undefined>;
  projects(): readonly ProjectHandle[];
}

const WATCH_DEBOUNCE_MS = 300;
const BUILD_OUTPUT_DIRS = new Set(["out", "cache", "broadcast", "node_modules", ".git"]);

/** Deletions under build output (e.g. `forge clean`) never affect the index. */
function isBuildOutput(sourceUnitName: string): boolean {
  return sourceUnitName.split("/").some((s) => BUILD_OUTPUT_DIRS.has(s));
}
const RELOAD_DEBOUNCE_MS = 1_000;

class ProjectEntry implements ProjectHandle {
  readonly ready: Promise<void>;
  indexing = true;
  private readonly disposables: vscode.Disposable[] = [];
  private pendingChanges = new Set<string>();
  private changeTimer: NodeJS.Timeout | undefined;
  private readonly cancellation = { isCancellationRequested: false };

  constructor(
    readonly model: ProjectModel,
    readonly indexer: ProjectIndexer,
    private readonly onChanged: (entry: ProjectEntry) => void,
    private readonly onConfigChanged: (root: string) => void,
    private readonly log: Logger,
  ) {
    this.ready = this.build();
    this.watch();
  }

  get index(): SymbolIndex {
    return this.indexer.index;
  }

  private async build(): Promise<void> {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `$(sync~spin) Indexing Solidity symbols (${path.basename(this.model.root)})` },
        () => this.indexer.build(this.cancellation),
      );
    } catch (err) {
      this.log.error(`Indexing failed for ${this.model.root}`, err);
    } finally {
      this.indexing = false;
      this.onChanged(this);
    }
  }

  private watch(): void {
    const root = vscode.Uri.file(this.model.root);
    // Sources: creation and modification are batched; deletions also cover whole directories.
    const sources = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "**/*.sol"), false, false, true);
    const deletions = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "**/*"), true, true, false);
    // Configuration and dependency changes (forge install/remove) reload the project.
    const libs = this.model.config.libs.join(",");
    const configGlob = `{foundry.toml,remappings.txt,{${libs}}/*,{${libs}}/*/remappings.txt,{${libs}}/*/foundry.toml}`;
    const config = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, configGlob));

    sources.onDidCreate((uri) => this.queue(uri), undefined, this.disposables);
    sources.onDidChange((uri) => this.queue(uri), undefined, this.disposables);
    deletions.onDidDelete(
      (uri) => {
        if (isBuildOutput(this.model.sourceUnitName(uri.fsPath))) return;
        this.pendingChanges.delete(uri.fsPath);
        this.indexer.removePath(uri.fsPath);
        this.onChanged(this);
      },
      undefined,
      this.disposables,
    );
    const reload = () => this.onConfigChanged(this.model.root);
    config.onDidCreate(reload, undefined, this.disposables);
    config.onDidChange(reload, undefined, this.disposables);
    config.onDidDelete(reload, undefined, this.disposables);
    this.disposables.push(sources, deletions, config);
  }

  private queue(uri: vscode.Uri): void {
    if (uri.scheme !== "file") return;
    this.pendingChanges.add(uri.fsPath);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => void this.flush(), WATCH_DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    this.changeTimer = undefined;
    const paths = [...this.pendingChanges];
    this.pendingChanges = new Set();
    if (paths.length === 0) return;
    // Wait for the initial build so incremental updates are applied on top of it.
    await this.ready;
    try {
      await this.indexer.updateFiles(paths);
      this.onChanged(this);
    } catch (err) {
      this.log.error("Incremental index update failed", err);
    }
  }

  dispose(): void {
    this.cancellation.isCancellationRequested = true;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    for (const d of this.disposables) d.dispose();
    this.indexer.dispose();
  }
}

export class WorkbenchCoreImpl implements WorkbenchCore, vscode.Disposable {
  private readonly entries = new Map<string, ProjectEntry>();
  private readonly loading = new Map<string, Promise<ProjectEntry>>();
  /** Root of each file seen, so repeated lookups do not walk the file system. */
  private readonly rootCache = new Map<string, string>();
  private readonly reloadTimers = new Map<string, NodeJS.Timeout>();
  private readonly changeEmitter = new vscode.EventEmitter<ProjectHandle>();
  private readonly disposables: vscode.Disposable[] = [];
  readonly onDidChangeIndex = this.changeEmitter.event;

  private readonly documents: DocumentAnalysisService;

  constructor(
    readonly log: Logger,
    private readonly parser: FileParser,
    private readonly cacheDir: string | undefined,
    /** Parser for interactive work (open documents), kept apart from indexing so it never waits behind it. */
    interactiveParser: FileParser,
  ) {
    this.documents = new DocumentAnalysisService(interactiveParser);
    this.disposables.push(
      this.documents,
      this.changeEmitter,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (affectsCore(e)) for (const root of this.entries.keys()) this.scheduleReload(root, 0);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.rootCache.clear();
        for (const root of [...this.entries.keys()]) {
          if (!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root))) this.unload(root);
        }
        void this.discover();
      }),
    );
  }

  analyzeDocument(document: vscode.TextDocument): Promise<AnalyzedDocument> {
    return this.documents.analyze(document);
  }

  analyzeFile(path: string): Promise<AnalyzedFile | undefined> {
    return this.documents.analyzeFile(path);
  }

  projects(): readonly ProjectHandle[] {
    return [...this.entries.values()];
  }

  /** Finds Foundry projects in the workspace and starts indexing them in the background. */
  async discover(): Promise<void> {
    const tomls = await vscode.workspace.findFiles("**/foundry.toml", "**/{node_modules,lib,out,cache}/**", 100);
    for (const toml of tomls) void this.projectFor(vscode.Uri.file(path.join(path.dirname(toml.fsPath), "_.sol")));
  }

  async projectFor(uri: vscode.Uri): Promise<ProjectHandle | undefined> {
    if (uri.scheme !== "file") return undefined;
    const root = await this.rootFor(uri);
    if (!root) return undefined;
    const existing = this.entries.get(root);
    if (existing) return existing;
    let pending = this.loading.get(root);
    if (!pending) {
      pending = this.load(root).finally(() => this.loading.delete(root));
      this.loading.set(root, pending);
    }
    return pending;
  }

  /** Rebuilds every project index from scratch (ignores the cache). */
  async rebuildAll(): Promise<void> {
    for (const root of [...this.entries.keys()]) {
      this.unload(root);
      if (this.cacheDir) await fs.rm(path.join(this.cacheDir, cacheFileName(root)), { force: true });
      this.register(await this.createEntry(root));
    }
  }

  private async rootFor(uri: vscode.Uri): Promise<string | undefined> {
    const dir = path.dirname(uri.fsPath);
    const cached = this.rootCache.get(dir);
    if (cached) return cached;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const ceiling = folder?.uri.fsPath ?? path.parse(uri.fsPath).root;
    const root = (await findProjectRoot(uri.fsPath, ceiling)) ?? folder?.uri.fsPath;
    if (root) this.rootCache.set(dir, root);
    return root;
  }

  private async load(root: string): Promise<ProjectEntry> {
    return this.register(await this.createEntry(root));
  }

  private register(entry: ProjectEntry): ProjectEntry {
    this.entries.set(entry.model.root, entry);
    this.changeEmitter.fire(entry);
    return entry;
  }

  /** Loads the project model and starts indexing, without exposing the entry yet. */
  private async createEntry(root: string): Promise<ProjectEntry> {
    const settings = readCoreSettings(vscode.Uri.file(root));
    const model = await loadProject(root, { forgePath: settings.forgePath });
    const source = model.remappingOrigin === "forge" ? `\`${model.forgeStatus} remappings\`` : `remappings.txt/foundry.toml/lib (${model.forgeStatus})`;
    this.log.info(`Project ${root}: ${model.remappings.length} remappings from ${source}`);
    for (const r of model.remappings) this.log.info(`  ${formatRemapping(r)}`);
    const indexer = new ProjectIndexer(model, settings.scope, {
      parser: this.parser,
      ...(this.cacheDir ? { cacheFile: path.join(this.cacheDir, cacheFileName(root)) } : {}),
      log: (m) => this.log.info(m),
    });
    return new ProjectEntry(
      model,
      indexer,
      (e) => {
        if (this.entries.get(root) === e) this.changeEmitter.fire(e);
      },
      (r) => this.scheduleReload(r, RELOAD_DEBOUNCE_MS),
      this.log,
    );
  }

  /**
   * Reloads remappings and configuration. The old index keeps serving
   * requests until the new one has been built (mostly from cache).
   */
  private scheduleReload(root: string, delay: number): void {
    const prev = this.reloadTimers.get(root);
    if (prev) clearTimeout(prev);
    this.reloadTimers.set(
      root,
      setTimeout(async () => {
        this.reloadTimers.delete(root);
        const old = this.entries.get(root);
        if (!old) return;
        this.log.info(`Reloading project ${root}`);
        await old.indexer.flushCache();
        const fresh = await this.createEntry(root);
        await fresh.ready;
        if (this.entries.get(root) === old) {
          old.dispose();
          this.register(fresh);
        } else {
          fresh.dispose();
        }
      }, delay),
    );
  }

  private unload(root: string): void {
    const entry = this.entries.get(root);
    this.entries.delete(root);
    for (const [dir, r] of this.rootCache) if (r === root) this.rootCache.delete(dir);
    entry?.dispose();
  }

  dispose(): void {
    for (const t of this.reloadTimers.values()) clearTimeout(t);
    for (const root of [...this.entries.keys()]) this.unload(root);
    for (const d of this.disposables) d.dispose();
    this.parser.dispose();
  }
}
