import * as assert from "node:assert/strict";
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

async function waitFor<T>(get: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The Markdown of every hover at `position`. */
async function hoverText(doc: vscode.TextDocument, position: vscode.Position): Promise<string> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", doc.uri, position);
  return hovers
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === "string" ? c : c.value))
    .join("\n");
}

function body(pragma: string, statements: string): string {
  return `// SPDX-License-Identifier: MIT\npragma solidity ${pragma};\n\ncontract Market {\n    function f(address a) external {\n        ${statements}\n    }\n}\n`;
}

suite("Hover", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "solidity-workbench")!;
    api = (await ext.activate()) as WorkbenchApi;
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("shows the type and documentation of msg.sender", async () => {
    const { doc, position } = await openAtMarker("src/HoverMsg.sol", body("^0.8.20", "address s = msg.sen|der;"));
    assert.ok(api.isFeatureActive("hover"));
    const text = await hoverText(doc, position);
    assert.match(text, /address msg\.sender/);
    assert.match(text, /Sender of the message/);
  });

  test("follows the pragma for global functions and deprecations", async () => {
    const { doc, position } = await openAtMarker("src/HoverDeprecated.sol", body("^0.8.20", "uint256 d = block.diffic|ulty; keccak256(abi.encode(d));"));
    assert.match(await hoverText(doc, position), /Deprecated since 0\.8\.18/);
    const keccak = doc.positionAt(doc.getText().indexOf("keccak256") + 2);
    assert.match(await hoverText(doc, keccak), /function keccak256\(bytes memory\) returns \(bytes32\)/);
  });

  test("can be disabled from the settings", async () => {
    const config = vscode.workspace.getConfiguration("solidityWorkbench");
    await config.update("hover.enabled", false, vscode.ConfigurationTarget.Workspace);
    try {
      await waitFor(() => !api.isFeatureActive("hover"));
      const { doc, position } = await openAtMarker("src/HoverDisabled.sol", body("^0.8.20", "msg.sen|der;"));
      assert.doesNotMatch(await hoverText(doc, position), /Sender of the message/);
    } finally {
      await config.update("hover.enabled", undefined, vscode.ConfigurationTarget.Workspace);
      await waitFor(() => api.isFeatureActive("hover"));
    }
  });
});
