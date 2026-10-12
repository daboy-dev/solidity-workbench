import * as path from "node:path";
import * as vscode from "vscode";
import { formatWithForge } from "../../core/foundry/format";
import { readCoreSettings } from "../../host/settings";
import type { WorkbenchCore } from "../../host/workbenchCore";
import { SOLIDITY_SELECTOR, type Feature } from "../feature";

/** Optional formatter backed by `forge fmt`. Disabled by default. */
export const formattingFeature: Feature = {
  id: "formatting",
  activate(core: WorkbenchCore): vscode.Disposable {
    return vscode.languages.registerDocumentFormattingEditProvider(SOLIDITY_SELECTOR, new ForgeFormatter(core));
  },
};

class ForgeFormatter implements vscode.DocumentFormattingEditProvider {
  constructor(private readonly core: WorkbenchCore) {}

  async provideDocumentFormattingEdits(document: vscode.TextDocument, _options: vscode.FormattingOptions, token: vscode.CancellationToken): Promise<vscode.TextEdit[]> {
    const project = await this.core.projectFor(document.uri);
    const root = project?.model.root ?? path.dirname(document.uri.fsPath);
    const text = document.getText();
    const version = document.version;
    const result = await formatWithForge(text, root, { forgePath: readCoreSettings(document.uri).forgePath });
    if (token.isCancellationRequested || document.version !== version) return [];
    if (!result.ok) {
      this.core.log.warn(`forge fmt failed for ${document.uri.fsPath}: ${result.error}`);
      vscode.window.setStatusBarMessage(`$(warning) forge fmt: ${result.error}`, 6_000);
      return [];
    }
    if (result.text === text) return [];
    // VS Code reduces a whole-document replacement to minimal edits, keeping the cursor in place.
    return [vscode.TextEdit.replace(new vscode.Range(document.positionAt(0), document.positionAt(text.length)), result.text)];
  }
}
