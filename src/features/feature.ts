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
