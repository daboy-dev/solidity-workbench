import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import type { WorkbenchApi } from "../../../src/extension";

const WORKSPACE = process.env["SW_TEST_WORKSPACE"]!;
const OZ_OWNABLE = "@openzeppelin/contracts/access/Ownable.sol";

let api: WorkbenchApi;

async function open(relPath: string, content: string): Promise<vscode.TextEditor> {
  const uri = vscode.Uri.file(path.join(WORKSPACE, relPath));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content));
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  await (await api.core.projectFor(uri))!.ready;
  return editor;
}

function rangeOf(doc: vscode.TextDocument, needle: string): vscode.Range {
  const offset = doc.getText().lastIndexOf(needle);
  assert.ok(offset >= 0, `"${needle}" not found`);
  return new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + needle.length));
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
}

suite("Auto import extras", () => {
  let diagnostics: vscode.DiagnosticCollection;

  suiteSetup(async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "solidity-workbench")!;
    api = (await ext.activate()) as WorkbenchApi;
    diagnostics = vscode.languages.createDiagnosticCollection("fake-solc");
  });

  suiteTeardown(() => diagnostics.dispose());

  teardown(async () => {
    diagnostics.clear();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("quick fix imports an undeclared identifier reported by solc", async () => {
    const editor = await open("src/Fix.sol", "pragma solidity ^0.8.20;\n\ncontract Fix is Ownable {}\n");
    const doc = editor.document;
    const range = rangeOf(doc, "Ownable");
    // As reported by solc through the Nomic Foundation or Juan Blanco extensions.
    const diag = new vscode.Diagnostic(range, "Identifier not found or not unique.", vscode.DiagnosticSeverity.Error);
    diag.code = "7920";
    diag.source = "solidity";
    diagnostics.set(doc.uri, [diag]);

    // Diagnostics reach the editor asynchronously: retry until they are part of the context.
    let actions: vscode.CodeAction[] = [];
    const deadline = Date.now() + 10_000;
    while (!actions.some((a) => a.title.startsWith("Import ")) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider",
        doc.uri,
        range,
        vscode.CodeActionKind.QuickFix.value,
      );
    }
    const titles = actions.map((a) => a.title);
    assert.ok(titles.includes(`Import Ownable from "${OZ_OWNABLE}"`), `got: ${titles.join(" | ")}`);
    // The best-ranked alternative comes first.
    assert.equal(titles.find((t) => t.startsWith("Import Ownable")), `Import Ownable from "${OZ_OWNABLE}"`);

    const action = actions.find((a) => a.title === `Import Ownable from "${OZ_OWNABLE}"`)!;
    assert.ok(await vscode.workspace.applyEdit(action.edit!));
    assert.equal(doc.getText(), `pragma solidity ^0.8.20;\n\nimport {Ownable} from "${OZ_OWNABLE}";\n\ncontract Fix is Ownable {}\n`);
  });

  test("quick fix ignores unrelated diagnostics", async () => {
    // Valid code (no real undeclared identifier), with an unrelated diagnostic on a name that exists in the index.
    const editor = await open("src/Other.sol", "pragma solidity ^0.8.20;\n\ncontract Other { uint256 Ownable; }\n");
    const doc = editor.document;
    const range = rangeOf(doc, "Ownable");
    diagnostics.set(doc.uri, [new vscode.Diagnostic(range, "Unused variable.", vscode.DiagnosticSeverity.Warning)]);
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", doc.uri, range);
    assert.ok(!actions.some((a) => a.title.startsWith("Import ")));
  });

  test("Add Solidity Import command with arguments", async () => {
    const editor = await open("src/Cmd.sol", "pragma solidity ^0.8.20;\n\ncontract Cmd {}\n");
    await vscode.commands.executeCommand("solidityWorkbench.addImport", { name: "IERC20" });
    assert.match(editor.document.getText(), /import \{IERC20\} from "@openzeppelin\/contracts\/token\/ERC20\/IERC20\.sol";/);
  });

  test("Add Solidity Import command through the quick pick", async () => {
    const editor = await open("src/Pick.sol", "pragma solidity ^0.8.20;\n\ncontract Pick is Context {}\n");
    const doc = editor.document;
    const word = rangeOf(doc, "Context");
    editor.selection = new vscode.Selection(word.start, word.start);
    // The picker opens prefilled with the word under the cursor; accept the first match.
    const done = vscode.commands.executeCommand("solidityWorkbench.addImport");
    await new Promise((r) => setTimeout(r, 1_000));
    await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
    await done;
    await waitFor(() => doc.getText().includes("import {Context}"));
    assert.match(doc.getText(), /import \{Context\} from "@openzeppelin\/contracts\/utils\/Context\.sol";/);
  });
});
