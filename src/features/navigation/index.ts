import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { subsequenceFilter } from "../../core/candidates";
import { findDefinitions, importPathRange, type DefinitionTarget } from "../../core/navigation/definitions";
import { analyzeFile } from "../../core/solidity/fileAnalysis";
import type { IndexedSymbol } from "../../core/index/symbolIndex";
import { createSourceHost, documentSource, positionIn } from "../../host/sourceHost";
import type { WorkbenchCore } from "../../host/workbenchCore";
import { symbolKindOf } from "./symbolKinds";
import { SOLIDITY_SELECTOR, type Feature } from "../feature";

/** Go to Definition, clickable import paths and Go to Symbol in Workspace. */
export const navigationFeature: Feature = {
  id: "navigation",
  activate(core: WorkbenchCore): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.languages.registerDefinitionProvider(SOLIDITY_SELECTOR, new DefinitionProvider(core)),
      vscode.languages.registerDocumentLinkProvider(SOLIDITY_SELECTOR, new ImportLinkProvider(core)),
      vscode.languages.registerWorkspaceSymbolProvider(new WorkspaceSymbolProvider(core)),
    );
  },
};

class DefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly core: WorkbenchCore) {}

  async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.LocationLink[]> {
    const file = await documentSource(this.core, document);
    if (!file) return [];
    const project = await this.core.projectFor(document.uri);
    const targets = await findDefinitions(createSourceHost(this.core, project), file, document.offsetAt(position));
    const origin = document.getWordRangeAtPosition(position, /[A-Za-z_$][\w$]*|[^"'\s]+/);
    return targets.map((t) => toLink(t, origin));
  }
}

function toLink(target: DefinitionTarget, origin: vscode.Range | undefined): vscode.LocationLink {
  const range = new vscode.Range(positionIn(target.text, target.start), positionIn(target.text, target.end));
  const selection = new vscode.Range(positionIn(target.text, target.nameStart), positionIn(target.text, target.nameEnd));
  return {
    ...(origin ? { originSelectionRange: origin } : {}),
    targetUri: vscode.Uri.file(target.path),
    targetRange: range.contains(selection) ? range : selection,
    targetSelectionRange: selection,
  };
}

/** Makes import paths clickable (Ctrl/Cmd+click opens the imported file). */
class ImportLinkProvider implements vscode.DocumentLinkProvider {
  constructor(private readonly core: WorkbenchCore) {}

  async provideDocumentLinks(document: vscode.TextDocument): Promise<vscode.DocumentLink[]> {
    const text = document.getText();
    const project = await this.core.projectFor(document.uri);
    const host = createSourceHost(this.core, project);
    const links: vscode.DocumentLink[] = [];
    for (const imp of analyzeFile(text).imports) {
      const range = importPathRange(imp, text);
      if (!range) continue;
      const target = host.resolveImport(imp.path, document.uri.fsPath);
      if (!(await exists(target))) continue;
      const link = new vscode.DocumentLink(new vscode.Range(document.positionAt(range.start), document.positionAt(range.end)), vscode.Uri.file(target));
      link.tooltip = path.relative(project?.model.root ?? path.dirname(document.uri.fsPath), target);
      links.push(link);
    }
    return links;
  }
}

const MAX_WORKSPACE_SYMBOLS = 500;

/** Go to Symbol in Workspace (Ctrl/Cmd+T) over the top-level symbols of every indexed project. */
class WorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
  constructor(private readonly core: WorkbenchCore) {}

  provideWorkspaceSymbols(query: string, token: vscode.CancellationToken): vscode.SymbolInformation[] {
    if (!query) return [];
    const matches = subsequenceFilter(query);
    const lower = query.toLowerCase();
    const seen = new Set<string>();
    const found: IndexedSymbol[] = [];
    for (const project of this.core.projects()) {
      for (const name of project.index.names()) {
        if (token.isCancellationRequested) return [];
        if (!matches(name)) continue;
        for (const symbol of project.index.lookup(name)) {
          const key = `${name}\u0000${symbol.file.realPath}`;
          if (seen.has(key)) continue;
          seen.add(key);
          found.push(symbol);
        }
      }
    }
    const score = (s: IndexedSymbol) => (s.name.startsWith(query) ? 0 : s.name.toLowerCase().startsWith(lower) ? 1 : 2);
    found.sort((a, b) => score(a) - score(b) || a.name.length - b.name.length || a.name.localeCompare(b.name));
    return found.slice(0, MAX_WORKSPACE_SYMBOLS).map((s) => {
      const root = this.core.projects().find((p) => s.file.path.startsWith(p.model.root + path.sep))?.model.root;
      const container = root ? path.relative(root, s.file.path) : path.basename(s.file.path);
      const location = new vscode.Location(vscode.Uri.file(s.file.path), new vscode.Position(s.line, s.character));
      return new vscode.SymbolInformation(s.name, symbolKindOf(s.kind), container, location);
    });
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}
