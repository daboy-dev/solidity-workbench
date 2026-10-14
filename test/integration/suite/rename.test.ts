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
    // The entry and every unsaved document (the rename may touch files that are not saved).
    overlays: new Map(vscode.workspace.textDocuments.filter((d) => d === doc || (d.uri.scheme === "file" && d.isDirty)).map((d) => [d.uri.fsPath, d.getText()])),
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

  test("refuses names already declared in the scope, and keywords or types", async () => {
    const editor = await open("src/RenameRefused.sol", SOURCE);
    const doc = editor.document;
    await assert.rejects(
      Promise.resolve(vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", doc.uri, at(doc, "amount_;"), "total")),
      /already declared/,
    );
    await assert.rejects(
      Promise.resolve(vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", doc.uri, at(doc, "uint256 public"), "value")),
      /no symbol here that can be renamed/,
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

  async function renameAt(doc: vscode.TextDocument, needle: string, newName: string): Promise<vscode.WorkspaceEdit> {
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>("vscode.executeDocumentRenameProvider", doc.uri, at(doc, needle), newName);
    assert.ok(edit, "expected a rename edit");
    return edit;
  }

  async function fileText(rel: string): Promise<string> {
    const uri = vscode.Uri.file(path.join(WORKSPACE, rel));
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    return open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  }

  const HEADER = "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n";

  test("renames a state variable across files, with getter calls, and the result compiles", async () => {
    await open("src/RenameStore.sol", `${HEADER}contract RenameStore {\n    uint256 public stored;\n    function put(uint256 v) external { stored = v; }\n}\n`);
    const testEditor = await open("test/RenameStore.t.sol", `${HEADER}import {RenameStore} from "../src/RenameStore.sol";\ncontract RenameStoreTest {\n    function check(RenameStore s) external view returns (uint256) { return s.stored(); }\n}\n`);
    const edit = await renameAt(testEditor.document, "stored()", "kept");
    assert.equal(edit.size, 2);
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.match(await fileText("src/RenameStore.sol"), /uint256 public kept;[\s\S]*kept = v;/);
    assert.match(testEditor.document.getText(), /return s\.kept\(\);/);
    assert.deepEqual(await compileErrors(testEditor.document), []);
  });

  test("renames a contract with its file and the imports, and the result compiles", async () => {
    await open("src/RenameVault.sol", `${HEADER}contract RenameVault {\n    function id() external pure returns (uint256) { return 1; }\n}\n`);
    const user = await open("src/RenameVaultUser.sol", `${HEADER}import {RenameVault} from "./RenameVault.sol";\ncontract RenameVaultUser {\n    RenameVault internal v = new RenameVault();\n}\n`);
    const edit = await renameAt(user.document, "RenameVault internal", "RenamedSafe");
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.equal(
      user.document.getText(),
      `${HEADER}import {RenamedSafe} from "./RenamedSafe.sol";\ncontract RenameVaultUser {\n    RenamedSafe internal v = new RenamedSafe();\n}\n`,
    );
    assert.match(await fileText("src/RenamedSafe.sol"), /contract RenamedSafe \{/);
    assert.deepEqual(await compileErrors(user.document), []);
  });

  test("updates named arguments in other files when renaming a parameter", async () => {
    await open("src/RenameNamedArgs.sol", `${HEADER}contract RenameNamedArgs {\n    function pay(uint256 amount, address to) external {}\n}\n`);
    const caller = await open("test/RenameNamedArgs.t.sol", `${HEADER}import {RenameNamedArgs} from "../src/RenameNamedArgs.sol";\ncontract RenameNamedArgsTest {\n    function t(RenameNamedArgs c) external { c.pay({amount: 1, to: address(this)}); }\n}\n`);
    const target = await open("src/RenameNamedArgs.sol", `${HEADER}contract RenameNamedArgs {\n    function pay(uint256 amount, address to) external {}\n}\n`);
    const edit = await renameAt(target.document, "amount,", "value");
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.match(target.document.getText(), /function pay\(uint256 value, address to\)/);
    assert.match(await fileText("test/RenameNamedArgs.t.sol"), /c\.pay\(\{value: 1, to: address\(this\)\}\)/);
    assert.ok(caller);
  });

  test("refuses symbols declared in lib/", async () => {
    const editor = await open("src/RenameLibUser.sol", `${HEADER}import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";\ncontract RenameLibUser is Ownable {\n    constructor() Ownable(msg.sender) {}\n}\n`);
    await assert.rejects(Promise.resolve(renameAt(editor.document, "Ownable {", "Owned")), /declared in lib\/openzeppelin-contracts/);
  });
});

