import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import type { WorkbenchApi } from "../../../src/extension";

const WORKSPACE = process.env["SW_TEST_WORKSPACE"]!;
const SOURCE = "solidity-workbench";

let api: WorkbenchApi;

async function open(relPath: string, content: string): Promise<vscode.TextEditor> {
  const uri = vscode.Uri.file(path.join(WORKSPACE, relPath));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content));
  return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
}

async function waitFor<T>(get: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function ours(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter((d) => d.source === SOURCE);
}

suite("Language basics", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "solidity-workbench")!;
    api = (await ext.activate()) as WorkbenchApi;
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("reports a misspelled keyword while typing and fixes it", async () => {
    const editor = await open("src/Typo.sol", "pragma solidity ^0.8.20;\n\ncontract Typo {}\n");
    const doc = editor.document;
    // Introduce the typo by editing, without saving.
    await editor.edit((b) => b.replace(new vscode.Range(2, 0, 2, 8), "contact"));
    const [diag] = await waitFor(() => (ours(doc.uri).length ? ours(doc.uri) : undefined));
    assert.equal(diag!.message, "Unknown keyword `contact`. Did you mean `contract`?");
    assert.equal(doc.getText(diag!.range), "contact");
    assert.ok(doc.isDirty, "diagnostics must not require saving");

    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", doc.uri, diag!.range);
    const fix = actions.find((a) => a.title === "Change to `contract`");
    assert.ok(fix, `got: ${actions.map((a) => a.title).join(" | ")}`);
    assert.ok(await vscode.workspace.applyEdit(fix.edit!));
    await waitFor(() => (ours(doc.uri).length === 0 ? true : undefined));
    assert.match(doc.getText(), /^contract Typo \{\}$/m);
  });

  test("reports a misspelled revert in a function body, not the parser's error", async () => {
    const editor = await open(
      "src/TypoRevert.sol",
      "pragma solidity ^0.8.20;\n\ncontract TypoRevert {\n    error OnlySeller();\n    function f() external pure {\n        revertr OnlySeller();\n    }\n}\n",
    );
    const diags = await waitFor(() => (ours(editor.document.uri).length ? ours(editor.document.uri) : undefined));
    assert.deepStrictEqual(
      diags.map((d) => [d.message, editor.document.getText(d.range)]),
      [["Unknown keyword `revertr`. Did you mean `revert`?", "revertr"]],
    );
  });

  test("points at the block left open", async () => {
    const editor = await open("src/Brace.sol", "contract Brace {\n  function f() public {\n    uint a = 1;\n\n  function g() public {}\n}\n");
    const [diag] = await waitFor(() => (ours(editor.document.uri).length ? ours(editor.document.uri) : undefined));
    assert.equal(diag!.message, "Missing `}` to close `function f` (opened on line 2).");
    assert.equal(diag!.range.start.line, 1);
  });

  test("provides the document outline", async () => {
    const editor = await open(
      "src/Outline.sol",
      "pragma solidity ^0.8.20;\nstruct P { uint a; }\ncontract O {\n  uint public total;\n  event E();\n  function f() external {}\n}\n",
    );
    const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", editor.document.uri);
    const names = result.map((s) => `${s.name}/${vscode.SymbolKind[s.kind]}`);
    assert.deepEqual(names, ["P/Struct", "O/Class"]);
    const contract = result.find((s) => s.name === "O")!;
    assert.deepEqual(
      contract.children.map((c) => `${c.name}/${vscode.SymbolKind[c.kind]}/${c.detail}`),
      ["total/Field/uint", "E/Event/event", "f/Method/external"],
    );
  });

  test("syntax diagnostics can be disabled from the settings", async () => {
    const editor = await open("src/Off2.sol", "contact Off2 {}\n");
    await waitFor(() => (ours(editor.document.uri).length ? true : undefined));
    const config = vscode.workspace.getConfiguration("solidityWorkbench");
    await config.update("syntaxDiagnostics.enabled", false, vscode.ConfigurationTarget.Workspace);
    try {
      await waitFor(() => (!api.isFeatureActive("syntaxDiagnostics") && ours(editor.document.uri).length === 0 ? true : undefined));
    } finally {
      await config.update("syntaxDiagnostics.enabled", undefined, vscode.ConfigurationTarget.Workspace);
      await waitFor(() => (api.isFeatureActive("syntaxDiagnostics") ? true : undefined));
    }
  });
});
