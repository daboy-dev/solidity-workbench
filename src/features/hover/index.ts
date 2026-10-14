import * as vscode from "vscode";
import { hoverAt, type HoverSection } from "../../core/hover/hover";
import { documentLanguageVersion } from "../../host/solc";
import type { WorkbenchCore } from "../../host/workbenchCore";
import { SOLIDITY_TEXT_SELECTOR, type Feature } from "../feature";

/** Hover: type and documentation of builtins and project symbols, without running solc. */
export const hoverFeature: Feature = {
  id: "hover",
  activate(core: WorkbenchCore): vscode.Disposable {
    return vscode.languages.registerHoverProvider(SOLIDITY_TEXT_SELECTOR, new SolidityHoverProvider(core));
  },
};

class SolidityHoverProvider implements vscode.HoverProvider {
  constructor(private readonly core: WorkbenchCore) {}

  async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    const structure = this.core.structures.structure(document);
    const project = document.uri.scheme === "file" ? await this.core.projectFor(document.uri) : undefined;
    const version = await documentLanguageVersion(document, project);
    if (token.isCancellationRequested) return undefined;
    const found = await hoverAt(structure, document.offsetAt(position), { version, path: document.uri.fsPath, host: this.core.structures.host(project) });
    if (!found || token.isCancellationRequested) return undefined;
    const range = new vscode.Range(document.positionAt(found.start), document.positionAt(found.end));
    return new vscode.Hover(found.sections.map(toMarkdown), range);
  }
}

function toMarkdown(section: HoverSection): vscode.MarkdownString {
  const md = new vscode.MarkdownString().appendCodeblock(section.code, "solidity");
  if (section.doc) md.appendMarkdown(`\n\n${section.doc}`);
  return md;
}
