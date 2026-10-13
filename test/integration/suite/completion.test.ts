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

async function waitFor<T>(get: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Accepts the first item of the suggest widget, as a user would. The widget opens
 * asynchronously and accepting before it is visible does nothing, so retry until the text changes.
 */
async function acceptFirstSuggestion(editor: vscode.TextEditor, position: vscode.Position): Promise<void> {
  const before = editor.document.getText();
  editor.selection = new vscode.Selection(position, position);
  const deadline = Date.now() + 10_000;
  while (editor.document.getText() === before && Date.now() < deadline) {
    await vscode.commands.executeCommand("editor.action.triggerSuggest");
    await new Promise((r) => setTimeout(r, 500));
    await vscode.commands.executeCommand("acceptSelectedSuggestion");
    await new Promise((r) => setTimeout(r, 100));
  }
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

  test("`add` + accept inserts `address`, before the `Address` library offered by auto-import", async () => {
    const lib = vscode.Uri.file(path.join(WORKSPACE, "src/AddressLib.sol"));
    await vscode.workspace.fs.writeFile(lib, Buffer.from("pragma solidity ^0.8.20;\nlibrary Address {}\n"));
    const project = (await api.core.projectFor(lib))!;
    await waitFor(() => project.index.lookup("Address").length > 0);

    const { editor, position } = await openAtMarker("src/Typed.sol", body("^0.8.20", "add|"));
    const labels = (await completions(editor.document, position)).map(labelOf);
    assert.ok(labels.includes("Address"), "the auto-import candidate is offered too");
    await acceptFirstSuggestion(editor, position);
    assert.match(editor.document.getText(), /^ {8}address$/m);
    assert.ok(!editor.document.getText().includes("import"), "no import was added");
  });

  test("can be disabled from the settings", async () => {
    const config = vscode.workspace.getConfiguration("solidityWorkbench");
    await config.update("completion.enabled", false, vscode.ConfigurationTarget.Workspace);
    try {
      await waitFor(() => !api.isFeatureActive("completion"));
      const { editor, position } = await openAtMarker("src/NoCompletion.sol", body("^0.8.20", "msg.|"));
      // VS Code's word-based suggestions may still list words of the document.
      const labels = (await completions(editor.document, position, ".")).map(labelOf);
      assert.ok(!labels.includes("sender"), `got: ${labels.join(", ")}`);
    } finally {
      await config.update("completion.enabled", undefined, vscode.ConfigurationTarget.Workspace);
      await waitFor(() => api.isFeatureActive("completion"));
    }
  });

  test("struct literal: missing fields left of `:`, matching values right of it", async () => {
    const source = (cursor: string) => `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Marketplace {
    struct Listing {
        address nftAddress;
        address sellerAddress;
        uint256 tokenId;
        uint256 price;
    }

    function listNFT(address nftAddress_, uint256 tokenId_, uint256 price_) external {
        Listing listing = Listing({
            nftAddress: nftAddress_,
            ${cursor}
        });
    }
}
`;
    let { editor, position } = await openAtMarker("src/Market.sol", source("|"));
    const fields = (await completions(editor.document, position)).filter((i) => i.kind === vscode.CompletionItemKind.Field).map(labelOf);
    assert.deepEqual(fields, ["sellerAddress", "tokenId", "price"]);
    await acceptFirstSuggestion(editor, position);
    assert.match(editor.document.getText(), /nftAddress_,\n {12}sellerAddress: \n/);
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");

    ({ editor, position } = await openAtMarker("src/Market2.sol", source("price: |")));
    await acceptFirstSuggestion(editor, position);
    assert.match(editor.document.getText(), /price: price_\n/);
  });

  test("the auto-import skips names already in scope", async () => {
    const { editor, position } = await openAtMarker("src/InScope.sol", body("^0.8.20", "uint256 Owned = 1;\n        Owne|"));
    const items = await completions(editor.document, position);
    const owned = items.filter((i) => labelOf(i) === "Owned");
    assert.equal(owned.length, 1, `got: ${items.map((i) => `${labelOf(i)}:${i.detail}`).join(" | ")}`);
    assert.equal(owned[0]!.kind, vscode.CompletionItemKind.Variable);
  });
});
