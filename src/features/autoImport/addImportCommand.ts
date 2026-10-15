import * as vscode from "vscode";
import type { ImportCandidate } from "../../core/candidates";
import type { SymbolKind } from "../../core/solidity/symbols";
import type { WorkbenchCore } from "../../host/workbenchCore";
import { candidateLabel, ImportContext } from "./importContext";

export const ADD_IMPORT_COMMAND = "solidityWorkbench.addImport";

/** Optional arguments, so the command can be bound to keys or scripted without the picker. */
export interface AddImportArgs {
  readonly name?: string;
  readonly importPath?: string;
}

interface CandidatePick extends vscode.QuickPickItem {
  readonly candidate: ImportCandidate;
}

/** "Add Solidity Import": pick any indexed symbol and import it into the active file. */
export function registerAddImportCommand(core: WorkbenchCore): vscode.Disposable {
  return vscode.commands.registerCommand(ADD_IMPORT_COMMAND, async (args?: AddImportArgs) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      void vscode.window.showInformationMessage("Open a Solidity file to add an import.");
      return;
    }
    const project = await core.projectFor(editor.document.uri);
    if (!project) {
      void vscode.window.showInformationMessage("This file is not part of a Solidity project.");
      return;
    }
    if (project.indexing) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Indexing Solidity symbols…" },
        () => project.ready,
      );
    }

    const ctx = ImportContext.create(editor.document, project);
    const candidates = ctx.candidates(args?.name ? { name: args.name } : {});
    const chosen = args?.importPath
      ? candidates.find((c) => c.importPath === args.importPath)
      : candidates.length === 1 && args?.name
        ? candidates[0]
        : await pick(candidates, args?.name ?? wordAtCursor(editor));
    if (!chosen) return;

    const edit = ctx.importEdit(chosen);
    if (edit && !(await editor.edit((b) => b.replace(edit.range, edit.newText)))) {
      void vscode.window.showErrorMessage(`Could not add the import for ${chosen.name}.`);
    }
  });
}

async function pick(candidates: readonly ImportCandidate[], initial: string | undefined): Promise<ImportCandidate | undefined> {
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage("No importable Solidity symbols found.");
    return undefined;
  }
  const quickPick = vscode.window.createQuickPick<CandidatePick>();
  quickPick.title = "Add Solidity Import";
  quickPick.placeholder = "Symbol to import";
  quickPick.matchOnDescription = true;
  quickPick.items = candidates.map((candidate) => ({
    candidate,
    label: `$(${iconFor(candidate.kind)}) ${candidate.insertText}`,
    description: candidate.importPath,
    detail: candidateLabel(candidate),
  }));
  if (initial) quickPick.value = initial;

  return new Promise((resolve) => {
    let result: ImportCandidate | undefined;
    quickPick.onDidAccept(() => {
      result = quickPick.selectedItems[0]?.candidate;
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      quickPick.dispose();
      resolve(result);
    });
    quickPick.show();
  });
}

function wordAtCursor(editor: vscode.TextEditor): string | undefined {
  const range = editor.document.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_$][A-Za-z0-9_$]*/);
  return range ? editor.document.getText(range) : undefined;
}

function iconFor(kind: SymbolKind): string {
  switch (kind) {
    case "interface":
      return "symbol-interface";
    case "library":
      return "symbol-module";
    case "struct":
      return "symbol-struct";
    case "enum":
      return "symbol-enum";
    case "event":
    case "error":
      return "symbol-event";
    case "type":
      return "symbol-type-parameter";
    case "function":
      return "symbol-function";
    case "constant":
      return "symbol-constant";
    default:
      return "symbol-class";
  }
}
