import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";
import type { WorkbenchApi } from "../../../src/extension";

const WORKSPACE = process.env["SW_TEST_WORKSPACE"]!;

let api: WorkbenchApi;

/** Opens `content` with its `|` marker removed; the position is where the marker was. */
async function openAtMarker(relPath: string, content: string): Promise<{ doc: vscode.TextDocument; position: vscode.Position }> {
  const offset = content.indexOf("|");
  const uri = vscode.Uri.file(path.join(WORKSPACE, relPath));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content.slice(0, offset) + content.slice(offset + 1)));
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  await (await api.core.projectFor(uri))?.ready;
  return { doc: editor.document, position: editor.document.positionAt(offset) };
}

async function hoverText(doc: vscode.TextDocument, position: vscode.Position): Promise<string> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", doc.uri, position);
  return hovers
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === "string" ? c : c.value))
    .join("\n");
}

/** Lines (1-based) of the definitions at `position`. */
async function definitionLines(doc: vscode.TextDocument, position: vscode.Position): Promise<number[]> {
  const found = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>("vscode.executeDefinitionProvider", doc.uri, position);
  return found.map((l) => ("targetRange" in l ? (l.targetSelectionRange ?? l.targetRange) : l.range).start.line + 1).sort((a, b) => a - b);
}

const SOURCE = (name: string, body: string) => `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

library ${name}Lib {
    /// @notice Sends \`amount\` to \`to\`.
    function send(IERC20 token, address to, uint256 amount) internal {}
    function send(IERC20 token, uint256 amount) internal {}
    function half(uint256 x) internal pure returns (uint256) { return x / 2; }
}

contract ${name} {
    using ${name}Lib for IERC20;
    using ${name}Lib for uint256;
    IERC20 token;

    function f(uint256 n, address who) external {
        ${body}
    }
}
`;

suite("Using for and overloads", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "solidity-workbench")!;
    api = (await ext.activate()) as WorkbenchApi;
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("suggests attached functions after a value, without the value", async () => {
    const { doc, position } = await openAtMarker("src/UsingComplete.sol", SOURCE("UsingComplete", "token.|"));
    assert.ok(api.isFeatureActive("completion"));
    const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", doc.uri, position);
    const send = list.items.find((i) => (typeof i.label === "string" ? i.label : i.label.label) === "send");
    assert.ok(send, "send is suggested");
    assert.strictEqual(send.detail, "send(address to, uint256 amount)");
    const labels = list.items.map((i) => (typeof i.label === "string" ? i.label : i.label.label));
    assert.ok(labels.includes("balanceOf"));
    assert.ok(!labels.includes("half"), "half takes a uint256, not an IERC20");
  });

  test("hovers and goes to attached functions without compiling, with the overload the arguments reach", async () => {
    const { doc, position } = await openAtMarker("src/UsingHover.sol", SOURCE("UsingHover", "token.se|nd(n); token.send(who, n); n.half();"));
    const one = await hoverText(doc, position);
    assert.match(one, /function send\(IERC20 token, uint256 amount\) internal/);
    assert.doesNotMatch(one, /address to/);
    const two = doc.positionAt(doc.getText().indexOf("token.send(who") + 8);
    assert.match(await hoverText(doc, two), /Sends `amount` to `to`\./);
    assert.deepStrictEqual(await definitionLines(doc, position), [9]);
    assert.deepStrictEqual(await definitionLines(doc, two), [8]);
    assert.deepStrictEqual(await definitionLines(doc, doc.positionAt(doc.getText().indexOf("n.half") + 3)), [10]);
  });
});
