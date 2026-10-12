import type * as vscode from "vscode";
import type { WorkbenchCore } from "../host/workbenchCore";

/**
 * A self-contained capability of the workbench (auto-import, and in the
 * future hover, go-to-definition, diagnostics...). Each feature is toggled by
 * `solidityWorkbench.<id>.enabled` and registers everything it needs in
 * `activate`, returning a disposable that unregisters it.
 */
export interface Feature {
  readonly id: string;
  activate(core: WorkbenchCore): vscode.Disposable;
}

/** Documents handled by the workbench, whichever extension (if any) owns the `solidity` language. */
export const SOLIDITY_SELECTOR: vscode.DocumentSelector = [
  { language: "solidity", scheme: "file" },
  { pattern: "**/*.sol", scheme: "file" },
];

/** Same documents as {@link SOLIDITY_SELECTOR}, plus unsaved Solidity buffers, for features that only need the text. */
export const SOLIDITY_TEXT_SELECTOR: vscode.DocumentSelector = [...(SOLIDITY_SELECTOR as vscode.DocumentFilter[]), { language: "solidity", scheme: "untitled" }];

export function isSolidityDocument(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== "file" && document.uri.scheme !== "untitled") return false;
  return document.languageId === "solidity" || document.uri.path.endsWith(".sol");
}
