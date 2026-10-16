import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import type { WorkbenchApi } from "../../../src/extension";

const WORKSPACE = process.env["SW_TEST_WORKSPACE"]!;
const OZ_OWNABLE = "@openzeppelin/contracts/access/Ownable.sol";

let api: WorkbenchApi;

async function openWith(relPath: string, content: string): Promise<vscode.TextEditor> {
  const uri = vscode.Uri.file(path.join(WORKSPACE, relPath));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content));
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const project = await api.core.projectFor(uri);
  assert.ok(project, "project not found");
  await project.ready;
  return editor;
}

function endOf(doc: vscode.TextDocument, needle: string): vscode.Position {
  const offset = doc.getText().lastIndexOf(needle);
  assert.ok(offset >= 0, `"${needle}" not found`);
  return doc.positionAt(offset + needle.length);
}

function labelOf(item: vscode.CompletionItem): string {
  return typeof item.label === "string" ? item.label : item.label.label;
}

function descriptionOf(item: vscode.CompletionItem): string | undefined {
  return typeof item.label === "string" ? undefined : item.label.description;
}

async function completions(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
  const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", doc.uri, position);
  return list.items.filter((i) => i.detail?.endsWith("auto import"));
}

/** Applies a completion the way the editor does: main edit plus additionalTextEdits. */
async function accept(editor: vscode.TextEditor, item: vscode.CompletionItem, position: vscode.Position): Promise<void> {
  const range = item.range instanceof vscode.Range ? item.range : item.range!.replacing;
  const ok = await editor.edit((b) => {
    b.replace(range.with({ end: position }), typeof item.insertText === "string" ? item.insertText : labelOf(item));
    for (const e of item.additionalTextEdits ?? []) b.replace(e.range, e.newText);
  });
  assert.ok(ok, "edit failed");
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
}

suite("Auto import", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "solidity-workbench");
    assert.ok(ext, "extension not found");
    api = (await ext.activate()) as WorkbenchApi;
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("suggests Ownable for `Ownab` and inserts the import when accepted in the editor", async () => {
    const editor = await openWith(
      "src/Vault.sol",
      "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n\ncontract Vault is Ownab {}\n",
    );
    const doc = editor.document;
    const position = endOf(doc, "Ownab");

    const items = await completions(doc, position);
    const ownable = items.filter((i) => labelOf(i) === "Ownable");
    assert.ok(ownable.length > 0, "Ownable not suggested");
    // The remapped OpenZeppelin path is ranked before the nested copy in lib/solmate-lite/lib/.
    assert.equal(descriptionOf(ownable[0]!), OZ_OWNABLE);
    assert.ok(
      ownable.some((i) => descriptionOf(i)?.includes("solmate-lite/lib/openzeppelin-contracts")),
      "nested copy should be offered as a separate suggestion",
    );

    // Real UI flow: trigger suggest and accept the first (best-ranked) item. The suggest widget
    // opens asynchronously and accepting before it is visible does nothing, so retry until it works.
    editor.selection = new vscode.Selection(position, position);
    const deadline = Date.now() + 10_000;
    while (!doc.getText().includes("import {Ownable}") && Date.now() < deadline) {
      await vscode.commands.executeCommand("editor.action.triggerSuggest");
      await new Promise((r) => setTimeout(r, 500));
      await vscode.commands.executeCommand("acceptSelectedSuggestion");
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.equal(
      doc.getText(),
      `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n\nimport {Ownable} from "${OZ_OWNABLE}";\n\ncontract Vault is Ownable {}\n`,
    );
  });

  test("offers an error declared in a contract, qualified, importing the contract", async () => {
    const editor = await openWith(
      "test/MemberImport.t.sol",
      "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n\ncontract MemberImportTest {\n    function test() external {\n        bytes4 s = OwnableUnauth\n    }\n}\n",
    );
    const doc = editor.document;
    const position = endOf(doc, "OwnableUnauth");
    const item = (await completions(doc, position)).find((i) => labelOf(i) === "OwnableUnauthorizedAccount" && descriptionOf(i) === OZ_OWNABLE);
    assert.ok(item, "OwnableUnauthorizedAccount not suggested");
    assert.equal(item.detail, "error in Ownable — auto import");
    await accept(editor, item, position);
    assert.equal(
      doc.getText(),
      `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n\nimport {Ownable} from "${OZ_OWNABLE}";\n\ncontract MemberImportTest {\n    function test() external {\n        bytes4 s = Ownable.OwnableUnauthorizedAccount\n    }\n}\n`,
    );
    // Ownable is now imported: only the qualification is needed.
    const again = endOf(doc, "bytes4 s = Ownable.OwnableUnauthorizedAccount");
    await editor.edit((b) => b.insert(again, ";\n        OwnableUnauth"));
    const second = endOf(doc, "        OwnableUnauth");
    const qualified = (await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", doc.uri, second)).items.find(
      (i) => labelOf(i) === "OwnableUnauthorizedAccount" && descriptionOf(i) === OZ_OWNABLE,
    );
    assert.ok(qualified, "still suggested with Ownable in scope");
    assert.equal(qualified.insertText, "Ownable.OwnableUnauthorizedAccount");
    assert.equal(qualified.additionalTextEdits, undefined);
  });

  test("offers only events after emit and only errors after revert", async () => {
    const editor = await openWith(
      "test/RaiseImport.t.sol",
      "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n\ncontract RaiseImportTest {\n    function test() external {\n        emit OwnableUnauth\n        revert OwnableUnauth\n        emit Deposit\n    }\n}\n",
    );
    const doc = editor.document;
    const labelsAt = async (needle: string) => (await completions(doc, endOf(doc, needle))).map((i) => `${labelOf(i)}:${i.insertText}`);
    assert.ok(!(await labelsAt("emit OwnableUnauth")).some((l) => l.startsWith("OwnableUnauthorizedAccount")), "an error after emit");
    assert.ok((await labelsAt("revert OwnableUnauth")).includes("OwnableUnauthorizedAccount:Ownable.OwnableUnauthorizedAccount"));
    assert.ok((await labelsAt("emit Deposit")).includes("Deposited:Deposited"));
  });

  test("accepting two symbols of the same file produces a single merged import", async () => {
    const editor = await openWith(
      "src/Book.sol",
      "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n\ncontract Book {\n    Positi\n}\n",
    );
    const doc = editor.document;

    let pos = endOf(doc, "Positi");
    const position = (await completions(doc, pos)).find((i) => labelOf(i) === "Position");
    assert.ok(position, "Position not suggested");
    assert.equal(descriptionOf(position), "./Types.sol");
    await accept(editor, position, pos);

    await editor.edit((b) => b.insert(endOf(doc, "Position"), " p;\n    Sid"));
    pos = endOf(doc, "Sid");
    const side = (await completions(doc, pos)).find((i) => labelOf(i) === "Side");
    assert.ok(side, "Side not suggested");
    await accept(editor, side, pos);

    const text = doc.getText();
    assert.match(text, /import \{Position, Side\} from "\.\/Types\.sol";/);
    assert.equal(text.match(/^import /gm)?.length, 1);
  });

  test("does not suggest in comments, strings, or for symbols already in scope", async () => {
    const editor = await openWith(
      "src/Scope.sol",
      [
        "// SPDX-License-Identifier: MIT",
        "pragma solidity ^0.8.20;",
        "",
        `import {Ownable} from "${OZ_OWNABLE}";`,
        "",
        "// IERC2",
        'contract Scope is Ownable { string s = "IERC2"; Ownab Contex }',
        "",
      ].join("\n"),
    );
    const doc = editor.document;
    const inComment = await completions(doc, endOf(doc, "// IERC2"));
    assert.equal(inComment.length, 0, "suggested inside a comment");
    const inString = await completions(doc, endOf(doc, '"IERC2'));
    assert.equal(inString.length, 0, "suggested inside a string");
    const imported = await completions(doc, endOf(doc, "Ownab "));
    assert.ok(!imported.some((i) => labelOf(i) === "Ownable" && descriptionOf(i) === OZ_OWNABLE), "suggested an imported symbol");
    const ctx = await completions(doc, endOf(doc, "Contex"));
    assert.ok(ctx.some((i) => labelOf(i) === "Context"), "Context should be suggested");
  });

  test("hides test and script symbols from src files", async () => {
    const editor = await openWith("src/Hidden.sol", "pragma solidity ^0.8.20;\ncontract Hidden is MockTok {}\n");
    const doc = editor.document;
    assert.ok(!(await completions(doc, endOf(doc, "MockTok"))).some((i) => labelOf(i) === "MockToken"));

    const testEditor = await openWith("test/Visible.t.sol", "pragma solidity ^0.8.20;\ncontract Visible is MockTok {}\n");
    const tdoc = testEditor.document;
    assert.ok((await completions(tdoc, endOf(tdoc, "MockTok"))).some((i) => labelOf(i) === "MockToken"));
  });

  test("picks up new files through the file watcher", async () => {
    const uri = vscode.Uri.file(path.join(WORKSPACE, "src/Fresh.sol"));
    await vscode.workspace.fs.writeFile(uri, Buffer.from("pragma solidity ^0.8.20;\nlibrary FreshMath {}\n"));
    const project = (await api.core.projectFor(uri))!;
    await waitFor(() => project.index.lookup("FreshMath").length > 0);
  });

  test("can be disabled from the settings", async () => {
    const config = vscode.workspace.getConfiguration("solidityWorkbench");
    await config.update("autoImport.enabled", false, vscode.ConfigurationTarget.Workspace);
    try {
      await waitFor(() => !api.isFeatureActive("autoImport"));
      const editor = await openWith("src/Off.sol", "pragma solidity ^0.8.20;\ncontract Off is Ownab {}\n");
      const doc = editor.document;
      assert.equal((await completions(doc, endOf(doc, "Ownab"))).length, 0);
    } finally {
      await config.update("autoImport.enabled", undefined, vscode.ConfigurationTarget.Workspace);
      await waitFor(() => api.isFeatureActive("autoImport"));
    }
  });
});
