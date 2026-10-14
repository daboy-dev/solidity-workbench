import * as vscode from "vscode";
import { localSymbolAt, renameLocal } from "../../core/references/locals";
import type { WorkbenchCore } from "../../host/workbenchCore";
import { SOLIDITY_TEXT_SELECTOR, type Feature } from "../feature";

/** Rename Symbol (F2). */
export const renameFeature: Feature = {
  id: "rename",
  activate(core: WorkbenchCore): vscode.Disposable {
    return vscode.languages.registerRenameProvider(SOLIDITY_TEXT_SELECTOR, new SolidityRenameProvider(core));
  },
};

class SolidityRenameProvider implements vscode.RenameProvider {
  constructor(private readonly core: WorkbenchCore) {}

  prepareRename(document: vscode.TextDocument, position: vscode.Position): { range: vscode.Range; placeholder: string } {
    const symbol = localSymbolAt(this.core.structures.structure(document), document.offsetAt(position));
    if (!symbol) throw new Error("Solidity Workbench can only rename local variables and parameters for now.");
    const range = symbol.occurrences.find((o) => o.start <= document.offsetAt(position) && document.offsetAt(position) <= o.end) ?? symbol.declaration;
    return { range: new vscode.Range(document.positionAt(range.start), document.positionAt(range.end)), placeholder: symbol.decl.name };
  }

  provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string): vscode.WorkspaceEdit {
    const structure = this.core.structures.structure(document);
    const symbol = localSymbolAt(structure, document.offsetAt(position));
    if (!symbol) throw new Error("Solidity Workbench can only rename local variables and parameters for now.");
    const result = renameLocal(structure, symbol, newName.trim());
    if (!result.ok) throw new Error(result.reason);
    const edit = new vscode.WorkspaceEdit();
    for (const e of result.edits) {
      edit.replace(document.uri, new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)), e.newText);
    }
    return edit;
  }
}
