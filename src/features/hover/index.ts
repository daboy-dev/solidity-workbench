import * as vscode from "vscode";
import { hoverAt, type AstLookup, type HoverSection } from "../../core/hover/hover";
import { occurrenceAt } from "../../core/references/rename";
import { documentLanguageVersion } from "../../host/solc";
import type { WorkbenchCore } from "../../host/workbenchCore";
import { SOLIDITY_TEXT_SELECTOR, type Feature } from "../feature";

/**
 * Hover: signature and NatSpec of project symbols, type and documentation of builtins.
 * Never runs solc: its AST is only used when it is already there for this exact text.
 */
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
    const file = document.uri.fsPath;
    const ast = project ? this.core.references.peek(project, file, document.getText()) : undefined;
    const lookup: AstLookup | undefined = ast
      ? (offset) => {
          const occurrence = occurrenceAt(ast.index, file, offset);
          const decl = occurrence && ast.index.decls.get(occurrence.key);
          return decl && { path: decl.file, nameStart: decl.nameStart };
        }
      : undefined;
    const found = await hoverAt(structure, document.offsetAt(position), { version, path: file, host: this.core.structures.host(project), ...(lookup ? { ast: lookup } : {}) });
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
