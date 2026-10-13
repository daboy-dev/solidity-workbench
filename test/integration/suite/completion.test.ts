import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import type { WorkbenchApi } from "../../../src/extension";

const WORKSPACE = process.env["SW_TEST_WORKSPACE"]!;

let api: WorkbenchApi;

async function open(relPath: string, content: string): Promise<vscode.TextEditor> {
  const uri = vscode.Uri.file(path.join(WORKSPACE, relPath));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content));
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  const project = await api.core.projectFor(uri);
  await project?.ready;
  return editor;
}

/** Position just after the `|` marker, which is removed from the content. */
async function openAtMarker(relPath: string, content: string): Promise<{ editor: vscode.TextEditor; position: vscode.Position }> {
  const offset = content.indexOf("|");
  const editor = await open(relPath, content.slice(0, offset) + content.slice(offset + 1));
  return { editor, position: editor.document.positionAt(offset) };
}

function labelOf(item: vscode.CompletionItem): string {
  return typeof item.label === "string" ? item.label : item.label.label;
}

async function completions(doc: vscode.TextDocument, position: vscode.Position, trigger?: string): Promise<vscode.CompletionItem[]> {
  const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", doc.uri, position, trigger);
  return list.items;
}

function body(pragma: string, statements: string): string {
  return `// SPDX-License-Identifier: MIT\npragma solidity ${pragma};\n\ncontract Market {\n    function f(address a) external {\n        ${statements}\n    }\n}\n`;
}

suite("Language completion", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "solidity-workbench")!;
    api = (await ext.activate()) as WorkbenchApi;
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("suggests msg members after `msg.`", async () => {
    const { editor, position } = await openAtMarker("src/Globals.sol", body("^0.8.20", "address s = msg.|"));
    assert.ok(api.isFeatureActive("completion"));
    const items = await completions(editor.document, position, ".");
    assert.deepEqual(items.map(labelOf).sort(), ["data", "sender", "sig", "value"]);
    assert.equal(items.find((i) => labelOf(i) === "sender")?.kind, vscode.CompletionItemKind.Property);
  });

  test("follows the pragma: block members and deprecated transfer", async () => {
    let { editor, position } = await openAtMarker("src/Old.sol", body("0.8.17", "block.|"));
    let labels = (await completions(editor.document, position, ".")).map(labelOf);
    assert.ok(labels.includes("timestamp"));
    assert.ok(!labels.includes("prevrandao"), "prevrandao needs 0.8.18");

    ({ editor, position } = await openAtMarker("src/New.sol", body("0.8.31", "payable(a).|")));
    const items = await completions(editor.document, position, ".");
    const transfer = items.find((i) => labelOf(i) === "transfer");
    assert.deepEqual(transfer?.tags, [vscode.CompletionItemTag.Deprecated]);
    labels = items.map(labelOf);
    assert.ok(labels.includes("balance") && labels.includes("call"));
  });
});
