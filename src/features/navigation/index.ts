import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { subsequenceFilter } from "../../core/candidates";
import { findDefinitions, importPathRange, type DefinitionTarget } from "../../core/navigation/definitions";
import { memberDefinition } from "../../core/navigation/memberDefinition";
import { localSymbolAt } from "../../core/references/locals";
import { relativeTo } from "../../core/references/projectRename";
import { findReferences } from "../../core/references/references";
import { compileProblem, occurrenceAt } from "../../core/references/rename";
import { analyzeFile } from "../../core/solidity/fileAnalysis";
import type { IndexedSymbol } from "../../core/index/symbolIndex";
import { createSourceHost, documentSource, positionConverter, positionIn } from "../../host/sourceHost";
import type { WorkbenchCore } from "../../host/workbenchCore";
import { symbolKindOf } from "./symbolKinds";
import { SOLIDITY_SELECTOR, type Feature } from "../feature";

/**
 * Go to Definition (locals, members of values and anything solc resolves included),
 * Find All References, Document Highlight, clickable import paths and Go to Symbol in Workspace.
 */
export const navigationFeature: Feature = {
  id: "navigation",
  activate(core: WorkbenchCore): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.languages.registerDefinitionProvider(SOLIDITY_SELECTOR, new DefinitionProvider(core)),
      vscode.languages.registerReferenceProvider(SOLIDITY_SELECTOR, new ReferenceProvider(core)),
      vscode.languages.registerDocumentHighlightProvider(SOLIDITY_SELECTOR, new HighlightProvider(core)),
      vscode.languages.registerDocumentLinkProvider(SOLIDITY_SELECTOR, new ImportLinkProvider(core)),
      vscode.languages.registerWorkspaceSymbolProvider(new WorkspaceSymbolProvider(core)),
    );
  },
};

const WORD = /[A-Za-z_$][\w$]*/;

class DefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly core: WorkbenchCore) {}

  async provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.LocationLink[]> {
    const offset = document.offsetAt(position);
    const structure = this.core.structures.structure(document);
    const word = document.getWordRangeAtPosition(position, WORD);
    const local = localSymbolAt(structure, offset);
    if (local) {
      const { start, end } = local.declaration;
      return [toLink({ path: document.uri.fsPath, start, end, nameStart: start, nameEnd: end, text: document.getText() }, word)];
    }
    const project = await this.core.projectFor(document.uri);
    const member = await memberDefinition(structure, offset, document.uri.fsPath, this.core.structures.host(project));
    if (member) {
      const end = member.nameStart + member.name.length;
      return [toLink({ path: member.path, start: member.nameStart, end, nameStart: member.nameStart, nameEnd: end, text: member.text }, word)];
    }
    const file = await documentSource(this.core, document);
    if (!file) return [];
    const targets = await findDefinitions(createSourceHost(this.core, project), file, offset);
    const origin = document.getWordRangeAtPosition(position, /[A-Za-z_$][\w$]*|[^"'\s]+/);
    if (targets.length || !word || !project || token.isCancellationRequested) return targets.map((t) => toLink(t, origin));
    // Anything else (`x.f()` through `using for`, overloads...): what solc resolved.
    try {
      const { ast, snapshot } = await this.core.references.ast(project);
      const occurrence = occurrenceAt(ast.index, document.uri.fsPath, offset);
      const decl = occurrence && ast.index.decls.get(occurrence.key);
      if (!decl) return [];
      const text = await textOf(decl.file, snapshot.sources);
      return [toLink({ path: decl.file, start: decl.nameStart, end: decl.nameEnd, nameStart: decl.nameStart, nameEnd: decl.nameEnd, text }, word)];
    } catch (err) {
      this.core.log.info(`Definition from solc unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
}

/** Find All References: locals with the tolerant parser, everything else with solc's AST. */
class ReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly core: WorkbenchCore) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[]> {
    const offset = document.offsetAt(position);
    const local = localSymbolAt(this.core.structures.structure(document), offset);
    if (local) {
      return local.occurrences
        .filter((o) => context.includeDeclaration || o.start !== local.declaration.start)
        .map((o) => new vscode.Location(document.uri, new vscode.Range(document.positionAt(o.start), document.positionAt(o.end))));
    }
    if (!document.getWordRangeAtPosition(position, WORD)) return [];
    const project = await this.core.projectFor(document.uri);
    if (!project) return [];
    const { ast, snapshot } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "$(sync~spin) Solidity Workbench: analysing the project with solc…" },
      () => this.core.references.ast(project),
    );
    if (token.isCancellationRequested) return [];
    const file = document.uri.fsPath;
    const rel = relativeTo(project.model);
    const problem = compileProblem(ast.groups, file, rel);
    const found = findReferences(ast.index, file, offset, snapshot.sources.get(file) ?? "");
    const decl = found.find((r) => r.declaration);
    const declProblem = decl && decl.file !== file ? compileProblem(ast.groups, decl.file, rel) : undefined;
    if (problem || declProblem) vscode.window.setStatusBarMessage(`$(warning) References may be incomplete: ${problem ?? declProblem}`, 10_000);
    const converters = new Map<string, (o: number) => vscode.Position>();
    const out: vscode.Location[] = [];
    for (const r of found) {
      if (!context.includeDeclaration && r.declaration) continue;
      let toPos = converters.get(r.file);
      if (!toPos) converters.set(r.file, (toPos = positionConverter(await textOf(r.file, snapshot.sources))));
      out.push(new vscode.Location(vscode.Uri.file(r.file), new vscode.Range(toPos(r.start), toPos(r.end))));
    }
    return out;
  }
}

/**
 * Highlights the symbol under the cursor in the document: locals always, other symbols
 * from the last AST when this file has not changed since (solc is never started for
 * this), else every occurrence of the same name in code.
 */
class HighlightProvider implements vscode.DocumentHighlightProvider {
  constructor(private readonly core: WorkbenchCore) {}

  async provideDocumentHighlights(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.DocumentHighlight[]> {
    const offset = document.offsetAt(position);
    const structure = this.core.structures.structure(document);
    const range = (start: number, end: number) => new vscode.Range(document.positionAt(start), document.positionAt(end));
    const local = localSymbolAt(structure, offset);
    if (local) {
      return local.occurrences.map(
        (o) => new vscode.DocumentHighlight(range(o.start, o.end), o.start === local.declaration.start ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Read),
      );
    }
    const word = document.getWordRangeAtPosition(position, WORD);
    if (!word) return [];
    const project = await this.core.projectFor(document.uri);
    const text = document.getText();
    const ast = project ? this.core.references.peek(project, document.uri.fsPath, text) : undefined;
    const file = document.uri.fsPath;
    if (ast) {
      const found = findReferences(ast.index, file, offset, text).filter((r) => r.file === file);
      if (found.length) {
        return found.map((r) => new vscode.DocumentHighlight(range(r.start, r.end), r.declaration ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Read));
      }
    }
    const name = document.getText(word);
    return structure.tokens.filter((t) => t.kind === "ident" && t.text === name).map((t) => new vscode.DocumentHighlight(range(t.start, t.end), vscode.DocumentHighlightKind.Text));
  }
}

async function textOf(file: string, sources: ReadonlyMap<string, string>): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === file);
  if (open) return open.getText();
  const known = sources.get(file);
  if (known !== undefined) return known;
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
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
