import * as vscode from "vscode";
import { listInstalledSolc, pragmaRanges, svmDirs, type InstalledSolc } from "../core/compiler/solcVersions";
import { languageVersion } from "../core/completion/languageVersion";
import { SECTION } from "./settings";
import type { ProjectHandle } from "./workbenchCore";

const INSTALLED_TTL_MS = 30_000;
let installed: { at: number; list: Promise<InstalledSolc[]> } | undefined;

/** solc binaries installed by forge (svm), listed at most every 30 s. */
export function installedSolc(): Promise<InstalledSolc[]> {
  if (!installed || Date.now() - installed.at > INSTALLED_TTL_MS) {
    installed = { at: Date.now(), list: listInstalledSolc(svmDirs()) };
  }
  return installed.list;
}

/** Forgets the installed versions, e.g. after starting `forge build`, which may install one. */
export function invalidateInstalledSolc(): void {
  installed = undefined;
}

/** The `compiler.solcPath` setting, if set. */
export function configuredSolc(resource?: vscode.Uri): string | undefined {
  return vscode.workspace.getConfiguration(SECTION, resource).get<string>("compiler.solcPath", "").trim() || undefined;
}

/** The solc version a document is written for (see {@link languageVersion}). */
export async function documentLanguageVersion(document: vscode.TextDocument, project: ProjectHandle | undefined): Promise<string> {
  const configured = configuredSolc(document.uri) ?? project?.model.compiler.solc;
  return languageVersion(await installedSolc(), pragmaRanges(document.getText()), configured);
}
