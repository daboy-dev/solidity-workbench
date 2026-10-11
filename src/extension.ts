import * as vscode from "vscode";
import { WorkerFileParser } from "./core/index/fileParser";
import { autoImportFeature } from "./features/autoImport";
import type { Feature } from "./features/feature";
import { FeatureRegistry } from "./features/registry";
import { createLogger } from "./host/logger";
import { WorkbenchCoreImpl, type WorkbenchCore } from "./host/workbenchCore";

/** Every feature of the workbench. New features are added here. */
const FEATURES: readonly Feature[] = [autoImportFeature];

export interface WorkbenchApi {
  readonly core: WorkbenchCore;
  isFeatureActive(id: string): boolean;
}

export function activate(context: vscode.ExtensionContext): WorkbenchApi {
  const log = createLogger();
  const parser = new WorkerFileParser(context.asAbsolutePath("dist/indexWorker.js"), (m) => log.warn(m));
  const cacheDir = (context.storageUri ?? context.globalStorageUri).fsPath;
  const core = new WorkbenchCoreImpl(log, parser, cacheDir);
  const registry = new FeatureRegistry(core, FEATURES);

  context.subscriptions.push(
    log,
    core,
    registry,
    vscode.commands.registerCommand("solidityWorkbench.rebuildIndex", () => core.rebuildAll()),
    vscode.commands.registerCommand("solidityWorkbench.showLog", () => log.show()),
    // Index projects of Solidity files opened later (e.g. outside any discovered project).
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme === "file" && doc.fileName.endsWith(".sol")) void core.projectFor(doc.uri);
    }),
  );

  void core.discover();
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === "file" && doc.fileName.endsWith(".sol")) void core.projectFor(doc.uri);
  }

  return { core, isFeatureActive: (id) => registry.isActive(id) };
}

export function deactivate(): void {}
