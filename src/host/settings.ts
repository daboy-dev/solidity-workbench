import * as vscode from "vscode";
import type { PathStyle } from "../core/candidates";
import type { IndexScope } from "../core/index/scanner";

export const SECTION = "solidityWorkbench";

/** Settings of the shared core (index, Foundry integration). Features read their own section. */
export interface CoreSettings {
  readonly scope: IndexScope;
  readonly forgePath: string;
}

export function readCoreSettings(resource?: vscode.Uri): CoreSettings {
  const cfg = vscode.workspace.getConfiguration(SECTION, resource);
  return {
    scope: {
      includeTests: cfg.get<boolean>("index.includeTests", true),
      includeScripts: cfg.get<boolean>("index.includeScripts", true),
      excludeLibTestsAndMocks: cfg.get<boolean>("index.excludeLibTestsAndMocks", true),
      exclude: cfg.get<string[]>("index.exclude", []),
    },
    forgePath: cfg.get<string>("foundry.forgePath", "forge") || "forge",
  };
}

export function isFeatureEnabled(featureId: string, resource?: vscode.Uri): boolean {
  return vscode.workspace.getConfiguration(SECTION, resource).get<boolean>(`${featureId}.enabled`, true);
}

export function readAutoImportPathStyle(resource?: vscode.Uri): PathStyle {
  const value = vscode.workspace.getConfiguration(SECTION, resource).get<string>("autoImport.pathStyle", "remapped");
  return value === "relative" ? "relative" : "remapped";
}

/** True when a configuration change affects how the index is built. */
export function affectsCore(e: vscode.ConfigurationChangeEvent): boolean {
  return e.affectsConfiguration(`${SECTION}.index`) || e.affectsConfiguration(`${SECTION}.foundry`);
}
