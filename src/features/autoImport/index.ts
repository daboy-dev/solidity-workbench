import * as vscode from "vscode";
import type { WorkbenchCore } from "../../host/workbenchCore";
import { SOLIDITY_SELECTOR, type Feature } from "../feature";
import { AutoImportCompletionProvider } from "./completionProvider";

export const autoImportFeature: Feature = {
  id: "autoImport",
  activate(core: WorkbenchCore): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.languages.registerCompletionItemProvider(SOLIDITY_SELECTOR, new AutoImportCompletionProvider(core)),
    );
  },
};
