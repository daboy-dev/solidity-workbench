import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import type { WorkbenchApi } from "../../../src/extension";
import { compile } from "../../../src/core/compiler/compile";
import { listInstalledSolc, svmDirs } from "../../../src/core/compiler/solcVersions";

const WORKSPACE = process.env["SW_TEST_WORKSPACE"]!;

let api: WorkbenchApi;

async function open(relPath: string, content: string): Promise<vscode.TextEditor> {
  const uri = vscode.Uri.file(path.join(WORKSPACE, relPath));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content));
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  await (await api.core.projectFor(uri))!.ready;
  return editor;
}

function at(doc: vscode.TextDocument, needle: string, delta = 1): vscode.Position {
  const offset = doc.getText().indexOf(needle);
  assert.ok(offset >= 0, `"${needle}" not found`);
  return doc.positionAt(offset + delta);
}

/** solc errors of the document as currently edited (empty when it compiles). */
async function compileErrors(doc: vscode.TextDocument): Promise<string[]> {
  const project = (await api.core.projectFor(doc.uri))!;
  const outcome = await compile({
    project: project.model,
    entry: doc.uri.fsPath,
    overlays: new Map([[doc.uri.fsPath, doc.getText()]]),
    installed: await listInstalledSolc(svmDirs()),
  });
  assert.equal(outcome.kind, "compiled", "no installed solc for the fixture (run forge build once)");
  if (outcome.kind !== "compiled") return [];
  return [...outcome.result.diagnostics.values()].flat().filter((d) => d.severity === "error").map((d) => d.message);
}

suite("Rename", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "solidity-workbench")!;
    api = (await ext.activate()) as WorkbenchApi;
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  const SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract RenameLocals {
    uint256 public amount;

    /// @param amount_ how much to add
    function add(uint256 amount_) external returns (uint256 total) {
        total = amount + amount_;
        {
            uint256 amount_2 = amount_ * 2;
            total += amount_2;
        }
        for (uint256 i; i < amount_; i++) total += i;
        amount = total;
    }
}
`;

  test("renames a parameter with its uses and NatSpec, and the result compiles", async () => {
    const editor = await open("src/RenameLocals.sol", SOURCE);
    const doc = editor.document;
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>("vscode.executeDocumentRenameProvider", doc.uri, at(doc, "amount_;"), "delta");
    assert.ok(edit, "expected a rename edit");
    assert.equal(edit.size, 1);
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.equal(doc.getText(), SOURCE.replace(/amount_(?!2)/g, "delta"));
    assert.deepEqual(await compileErrors(doc), []);
  });

  test("refuses names already declared in the scope and anything that is not a local", async () => {
    const editor = await open("src/RenameRefused.sol", SOURCE);
    const doc = editor.document;
    await assert.rejects(
      Promise.resolve(vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", doc.uri, at(doc, "amount_;"), "total")),
      /already declared/,
    );
    await assert.rejects(
      Promise.resolve(vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", doc.uri, at(doc, "amount +"), "value")),
      /only rename local variables/,
    );
  });

  test("goes to the definition of a local", async () => {
    const editor = await open("src/RenameDefinition.sol", SOURCE);
    const doc = editor.document;
    const result = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
      "vscode.executeDefinitionProvider",
      doc.uri,
      at(doc, "amount_2;"),
    );
    const lines = result.map((r) => (r instanceof vscode.Location ? r.range : r.targetSelectionRange ?? r.targetRange).start.line + 1);
    assert.deepEqual(lines, [11]);
    // A state variable still resolves through the index.
    const state = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>("vscode.executeDefinitionProvider", doc.uri, at(doc, "amount +"));
    assert.deepEqual(
      state.map((r) => (r instanceof vscode.Location ? r.range : r.targetSelectionRange ?? r.targetRange).start.line + 1),
      [5],
    );
  });
});
