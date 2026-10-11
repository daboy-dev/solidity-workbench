import * as vscode from "vscode";
import type { WorkbenchCore } from "../../host/workbenchCore";
import { SOLIDITY_SELECTOR, type Feature } from "../feature";
import { registerAddImportCommand } from "./addImportCommand";
import { AutoImportCodeActionProvider } from "./codeActionProvider";
import { AutoImportCompletionProvider } from "./completionProvider";

export const autoImportFeature: Feature = {
  id: "autoImport",
  activate(core: WorkbenchCore): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.languages.registerCompletionItemProvider(SOLIDITY_SELECTOR, new AutoImportCompletionProvider(core)),
      vscode.languages.registerCodeActionsProvider(
        SOLIDITY_SELECTOR,
        new AutoImportCodeActionProvider(core),
        AutoImportCodeActionProvider.metadata,
      ),
      registerAddImportCommand(core),
    );
  },
};
