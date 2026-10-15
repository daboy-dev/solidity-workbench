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

async function waitFor<T>(get: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The active signature with its active parameter between brackets, or "(none)". */
async function shown(doc: vscode.TextDocument, position: vscode.Position, trigger = "("): Promise<string> {
  const help = await vscode.commands.executeCommand<vscode.SignatureHelp | undefined>("vscode.executeSignatureHelpProvider", doc.uri, position, trigger);
  const s = help?.signatures[help.activeSignature];
  if (!s) return "(none)";
  const p = s.parameters[s.activeParameter ?? help.activeParameter];
  if (!p || typeof p.label === "string") return s.label;
  const [a, b] = p.label;
  return `${s.label.slice(0, a)}[${s.label.slice(a, b)}]${s.label.slice(b)}`;
}

const SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

library SigPay {
    /// @notice Pays \`amount\`.
    /// @param to Who is paid.
    function pay(IERC20 token, address to, uint256 amount) internal {}
}

contract SigVault is Ownable {
    using SigPay for IERC20;
    IERC20 token;

    constructor() Ownable(msg.sender) {}

    function put(address to, uint256 amount) internal {}
    function put(uint256 amount) internal {}

    function f(uint256 n, address who) external {
        BODY
    }
}
`;

suite("Signature help", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "solidity-workbench")!;
    api = (await ext.activate()) as WorkbenchApi;
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("shows parameters through remappings, with NatSpec", async () => {
    const { doc, position } = await openAtMarker("src/SigRemap.sol", SOURCE.replace("BODY", "token.balanceOf(|);"));
    assert.ok(api.isFeatureActive("signatureHelp"));
    assert.strictEqual(await shown(doc, position), "function balanceOf([address account]) returns (uint256)");
    const ctor = doc.positionAt(doc.getText().indexOf("msg.sender)"));
    assert.strictEqual(await shown(doc, ctor), "Ownable([address initialOwner])");
  });

  test("leaves out the value of attached functions and shows their documentation", async () => {
    const { doc, position } = await openAtMarker("src/SigUsing.sol", SOURCE.replace("BODY", "token.pay(|);"));
    assert.strictEqual(await shown(doc, position), "function pay([address to], uint256 amount)");
    const help = await vscode.commands.executeCommand<vscode.SignatureHelp>("vscode.executeSignatureHelpProvider", doc.uri, position, "(");
    const docs = help.signatures[0]!.documentation;
    assert.match(typeof docs === "string" ? docs : (docs?.value ?? ""), /Pays `amount`\./);
  });

  test("selects the overload the arguments reach", async () => {
    const { doc, position } = await openAtMarker("src/SigOverload.sol", SOURCE.replace("BODY", "put(who, |);"));
    assert.strictEqual(await shown(doc, position, ","), "function put(address to, [uint256 amount])");
    const help = await vscode.commands.executeCommand<vscode.SignatureHelp>("vscode.executeSignatureHelpProvider", doc.uri, position, ",");
    assert.strictEqual(help.signatures.length, 2);
  });

  test("can be disabled from the settings", async () => {
    const config = vscode.workspace.getConfiguration("solidityWorkbench");
    await config.update("signatureHelp.enabled", false, vscode.ConfigurationTarget.Workspace);
    try {
      await waitFor(() => !api.isFeatureActive("signatureHelp"));
      const { doc, position } = await openAtMarker("src/SigDisabled.sol", SOURCE.replace("BODY", "put(|);"));
      assert.strictEqual(await shown(doc, position), "(none)");
    } finally {
      await config.update("signatureHelp.enabled", undefined, vscode.ConfigurationTarget.Workspace);
      await waitFor(() => api.isFeatureActive("signatureHelp"));
    }
  });
});
