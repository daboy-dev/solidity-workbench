import * as vscode from "vscode";
import { signatureHelpAt } from "../../core/signature/signature";
import { documentLanguageVersion } from "../../host/solc";
import type { WorkbenchCore } from "../../host/workbenchCore";
import { SOLIDITY_TEXT_SELECTOR, type Feature } from "../feature";

/**
 * Signature help: the parameters of the call being written, with NatSpec, for project
 * functions, events, errors, structs, constructors, modifiers and built-in functions.
 * Never runs solc.
 */
export const signatureHelpFeature: Feature = {
  id: "signatureHelp",
  activate(core: WorkbenchCore): vscode.Disposable {
    return vscode.languages.registerSignatureHelpProvider(SOLIDITY_TEXT_SELECTOR, new SoliditySignatureHelpProvider(core), {
      triggerCharacters: ["(", ","],
      retriggerCharacters: [")", "{", ":"],
    });
  },
};

class SoliditySignatureHelpProvider implements vscode.SignatureHelpProvider {
  constructor(private readonly core: WorkbenchCore) {}

  async provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.SignatureHelp | undefined> {
    const structure = this.core.structures.structure(document);
    const project = document.uri.scheme === "file" ? await this.core.projectFor(document.uri) : undefined;
    const version = await documentLanguageVersion(document, project);
    if (token.isCancellationRequested) return undefined;
    const found = await signatureHelpAt(structure, document.offsetAt(position), { version, path: document.uri.fsPath, host: this.core.structures.host(project) });
    if (!found || token.isCancellationRequested) return undefined;
    const help = new vscode.SignatureHelp();
    help.signatures = found.signatures.map((s) => {
      const info = new vscode.SignatureInformation(s.label, s.documentation ? new vscode.MarkdownString(s.documentation) : undefined);
      info.parameters = s.parameters.map((p) => new vscode.ParameterInformation([p.label[0], p.label[1]], p.documentation ? new vscode.MarkdownString(p.documentation) : undefined));
      info.activeParameter = s.activeParameter;
      return info;
    });
    help.activeSignature = found.activeSignature;
    help.activeParameter = found.signatures[found.activeSignature]?.activeParameter ?? 0;
    return help;
  }
}
