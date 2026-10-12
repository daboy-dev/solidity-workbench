import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import type { WorkbenchApi } from "../../../src/extension";

const WORKSPACE = process.env["SW_TEST_WORKSPACE"]!;
const OZ = "@openzeppelin/contracts/access/Ownable.sol";

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

async function definitions(doc: vscode.TextDocument, position: vscode.Position): Promise<string[]> {
  const result = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
    "vscode.executeDefinitionProvider",
    doc.uri,
    position,
  );
  return result.map((r) => {
    const [uri, range] = r instanceof vscode.Location ? [r.uri, r.range] : [r.targetUri, r.targetSelectionRange ?? r.targetRange];
    return `${path.relative(WORKSPACE, uri.fsPath)}:${range.start.line + 1}`;
  });
}

suite("Navigation and formatting", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "solidity-workbench")!;
    api = (await ext.activate()) as WorkbenchApi;
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  const SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "${OZ}";
import {Position} from "./Types.sol";

contract Nav is Ownable {
    Position internal pos;
    constructor() Ownable(msg.sender) {}
    function f() external onlyOwner returns (address) { return _msgSender(); }
}
`;

  test("goes to definitions through remappings, imports and inheritance", async () => {
    const editor = await open("src/Nav.sol", SOURCE);
    const doc = editor.document;
    const ownable = "lib/openzeppelin-contracts/contracts/access/Ownable.sol";
    assert.deepEqual(await definitions(doc, at(doc, "Ownable {")), [`${ownable}:7`]);
    assert.deepEqual(await definitions(doc, at(doc, "Position internal")), ["src/Types.sol:4"]);
    assert.deepEqual(await definitions(doc, at(doc, "onlyOwner")), [`${ownable}:16`]);
    // Inherited through Ownable is Context, in another file reached by a relative import.
    assert.deepEqual(await definitions(doc, at(doc, "_msgSender")), ["lib/openzeppelin-contracts/contracts/utils/Context.sol:6"]);
    // The import path itself opens the file.
    assert.deepEqual(await definitions(doc, at(doc, OZ, 5)), [`${ownable}:1`]);
  });

  test("makes import paths clickable", async () => {
    const editor = await open("src/Links.sol", SOURCE);
    const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>("vscode.executeLinkProvider", editor.document.uri);
    const targets = links.map((l) => path.relative(WORKSPACE, l.target!.fsPath)).sort();
    assert.deepEqual(targets, ["lib/openzeppelin-contracts/contracts/access/Ownable.sol", "src/Types.sol"]);
  });

  test("finds project symbols with Go to Symbol in Workspace", async () => {
    await open("src/Ws.sol", "pragma solidity ^0.8.20;\ncontract Ws {}\n");
    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", "Ownab");
    const ours = symbols.filter((s) => s.name === "Ownable").map((s) => path.relative(WORKSPACE, s.location.uri.fsPath)).sort();
    assert.deepEqual(ours, [
      "lib/openzeppelin-contracts/contracts/access/Ownable.sol",
      "lib/solmate-lite/lib/openzeppelin-contracts/contracts/access/Ownable.sol",
    ]);
  });

  test("formatting is off by default and uses forge fmt when enabled", async () => {
    const editor = await open("src/Fmt.sol", "pragma solidity ^0.8.20;\ncontract   Fmt{uint a=1;}\n");
    const doc = editor.document;
    const opts = { tabSize: 4, insertSpaces: true };
    const none = await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>("vscode.executeFormatDocumentProvider", doc.uri, opts);
    assert.equal(none?.length ?? 0, 0, "no formatter should be registered by default");

    const config = vscode.workspace.getConfiguration("solidityWorkbench");
    await config.update("formatting.enabled", true, vscode.ConfigurationTarget.Workspace);
    try {
      let edits: vscode.TextEdit[] | undefined;
      for (let i = 0; i < 50 && !edits?.length; i++) {
        await new Promise((r) => setTimeout(r, 100));
        edits = await vscode.commands.executeCommand<vscode.TextEdit[]>("vscode.executeFormatDocumentProvider", doc.uri, opts);
      }
      assert.ok(edits?.length, "expected forge fmt edits (is forge installed?)");
      const we = new vscode.WorkspaceEdit();
      we.set(doc.uri, edits);
      assert.ok(await vscode.workspace.applyEdit(we));
      assert.equal(doc.getText(), "pragma solidity ^0.8.20;\n\ncontract Fmt {\n    uint256 a = 1;\n}\n");
    } finally {
      await config.update("formatting.enabled", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });
});
