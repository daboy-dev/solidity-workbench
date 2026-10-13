import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import { listInstalledSolc, svmDirs } from "../../../src/core/compiler/solcVersions";
import type { WorkbenchApi } from "../../../src/extension";

const WORKSPACE = process.env["SW_TEST_WORKSPACE"]!;
const OZ = "@openzeppelin/contracts/access/Ownable.sol";

let api: WorkbenchApi;

async function open(relPath: string, content: string): Promise<vscode.TextEditor> {
  const uri = vscode.Uri.file(path.join(WORKSPACE, relPath));
  await vscode.workspace.fs.writeFile(uri, Buffer.from("// placeholder\n"));
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  await (await api.core.projectFor(uri))!.ready;
  // Write the content as an unsaved edit: everything below must work before saving.
  await editor.edit((b) => b.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), content));
  return editor;
}

function solc(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter((d) => d.source === "solc");
}

async function waitFor<T>(get: () => T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function codeActions(doc: vscode.TextDocument, range: vscode.Range): Promise<string[]> {
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", doc.uri, range);
  return actions.map((a) => a.title);
}

const HEADER = "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n\n";

suite("Compiler diagnostics", function () {
  suiteSetup(async function () {
    if ((await listInstalledSolc(svmDirs())).length === 0) this.skip();
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "solidity-workbench")!;
    api = (await ext.activate()) as WorkbenchApi;
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("reports missing base constructor arguments before saving, and clears when fixed", async () => {
    const editor = await open("src/Ctor.sol", `${HEADER}import {Ownable} from "${OZ}";\n\ncontract Ctor is Ownable {}\n`);
    const doc = editor.document;
    const [diag] = await waitFor(() => solc(doc.uri).length > 0 && solc(doc.uri), "solc diagnostics");
    assert.equal(diag!.code, "3415");
    assert.match(diag!.message, /No arguments passed to the base constructor/);
    // solc points at the whole contract; only its header is underlined.
    assert.equal(doc.getText(diag!.range), "contract Ctor is Ownable");
    assert.ok(doc.isDirty);

    await editor.edit((b) => b.replace(new vscode.Range(diag!.range.end, diag!.range.end.translate(0, 3)), " { constructor() Ownable(msg.sender) {} }"));
    await waitFor(() => solc(doc.uri).length === 0, "diagnostics to clear");
  });

  test("its undeclared identifier errors drive the import quick fix", async () => {
    const editor = await open("src/Undeclared.sol", `${HEADER}contract Undeclared is Ownable {\n    constructor() Ownable(msg.sender) {}\n}\n`);
    const doc = editor.document;
    const diag = await waitFor(() => solc(doc.uri).find((d) => d.code === "7920"), "error 7920");
    const titles = await codeActions(doc, diag.range);
    assert.ok(titles.includes(`Import Ownable from "${OZ}"`), titles.join(" | "));
  });

  test("suggests the keyword for misspelled identifiers, with a fix", async () => {
    const editor = await open("src/Typo2.sol", `${HEADER}contract Typo2 {\n    function f() public pure retruns (uint256) { return 1; }\n}\n`);
    const doc = editor.document;
    const diag = await waitFor(() => solc(doc.uri).find((d) => /retruns|Did you mean/.test(d.message) || doc.getText(d.range) === "retruns"), "typo diagnostic");
    assert.match(diag.message, /Did you mean `returns`\?/);
    assert.ok((await codeActions(doc, diag.range)).includes("Change to `returns`"));
  });

  test("leaves syntax errors to the syntax layer", async () => {
    const editor = await open("src/Syntax2.sol", `${HEADER}contact Syntax2 {}\n`);
    const doc = editor.document;
    await waitFor(() => vscode.languages.getDiagnostics(doc.uri).some((d) => d.source === "solidity-workbench"), "syntax diagnostic");
    // Give solc time to run as well; it must not add its own ParserError.
    await new Promise((r) => setTimeout(r, 1_500));
    assert.deepEqual(solc(doc.uri).map((d) => d.code), []);
  });
});
