import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import type { WorkbenchApi } from "../../../src/extension";

const WORKSPACE = process.env["SW_TEST_WORKSPACE"]!;
const HEADER = "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n";

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

const where = (l: vscode.Location | vscode.LocationLink) => {
  const [uri, range] = l instanceof vscode.Location ? [l.uri, l.range] : [l.targetUri, l.targetSelectionRange ?? l.targetRange];
  return `${path.relative(WORKSPACE, uri.fsPath)}:${range.start.line + 1}:${range.start.character + 1}`;
};

suite("References and highlights", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "solidity-workbench")!;
    api = (await ext.activate()) as WorkbenchApi;
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  const LEDGER = `${HEADER}struct RefEntry {\n    uint256 amount;\n}\ncontract RefLedger {\n    RefEntry[] internal entries;\n    function record(uint256 v) external { entries.push(RefEntry({amount: v})); }\n}\n`;
  const CLIENT = `${HEADER}import {RefLedger, RefEntry} from "../src/RefLedger.sol";\ncontract RefClient {\n    RefLedger internal ledger;\n    function run(RefEntry memory e) external {\n        ledger.record(e.amount);\n        ledger.record(1);\n    }\n}\n`;

  test("finds references of a function across files", async () => {
    await open("src/RefLedger.sol", LEDGER);
    const client = await open("test/RefClient.t.sol", CLIENT);
    const refs = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeReferenceProvider", client.document.uri, at(client.document, "record(e"));
    assert.deepEqual(refs.map(where).sort(), ["src/RefLedger.sol:8:14", "test/RefClient.t.sol:7:16", "test/RefClient.t.sol:8:16"]);
    const fields = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeReferenceProvider", client.document.uri, at(client.document, "amount);"));
    assert.deepEqual(fields.map(where).sort(), ["src/RefLedger.sol:4:13", "src/RefLedger.sol:8:66", "test/RefClient.t.sol:7:25"]);
  });

  test("goes to the definition of members of values without compiling", async () => {
    await open("src/RefLedger2.sol", LEDGER.replace(/RefLedger/g, "RefLedger2").replace(/RefEntry/g, "RefEntry2"));
    const client = await open("test/RefClient2.t.sol", CLIENT.replace(/RefLedger/g, "RefLedger2").replace(/RefEntry/g, "RefEntry2").replace("ledger.record(1);", "ledger.record(1)"));
    const defs = async (needle: string) =>
      (await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>("vscode.executeDefinitionProvider", client.document.uri, at(client.document, needle))).map(where);
    assert.deepEqual(await defs("record(e"), ["src/RefLedger2.sol:8:14"]);
    assert.deepEqual(await defs("amount);"), ["src/RefLedger2.sol:4:13"]);
  });

  test("highlights locals and, once compiled, symbols in the document", async () => {
    await open("src/RefLedger3.sol", LEDGER.replace(/RefLedger/g, "RefLedger3").replace(/RefEntry/g, "RefEntry3"));
    const editor = await open("src/RefHighlight.sol", `${HEADER}contract RefHighlight {\n    uint256 internal total;\n    function add(uint256 total_) external { total += total_; total_ = 0; }\n}\ncontract Other { uint256 internal total; }\n`);
    const doc = editor.document;
    const highlights = async (needle: string, delta = 1) =>
      (await vscode.commands.executeCommand<vscode.DocumentHighlight[]>("vscode.executeDocumentHighlights", doc.uri, at(doc, needle, delta))).map((h) => `${h.range.start.line + 1}:${h.range.start.character + 1}`);
    assert.deepEqual(await highlights("total_)"), ["5:26", "5:54", "5:62"]);
    // Before solc ran: every `total` in code.
    assert.deepEqual(await highlights("total +="), ["4:22", "5:45", "7:35"]);
    await vscode.commands.executeCommand("vscode.executeReferenceProvider", doc.uri, at(doc, "total +="));
    assert.deepEqual(await highlights("total +="), ["4:22", "5:45"]);
  });
});
