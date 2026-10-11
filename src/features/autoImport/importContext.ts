import * as vscode from "vscode";
import { findImportCandidates, type CandidateQuery, type ImportCandidate } from "../../core/candidates";
import { analyzeFile, type FileAnalysis } from "../../core/solidity/fileAnalysis";
import { computeImportEdit } from "../../core/solidity/importEdit";
import type { SymbolKind } from "../../core/solidity/symbols";
import type { ProjectHandle } from "../../host/workbenchCore";
import { readAutoImportPathStyle } from "../../host/settings";

/** Everything needed to propose imports for one document version. */
export class ImportContext {
  private constructor(
    readonly document: vscode.TextDocument,
    readonly project: ProjectHandle,
    readonly analysis: FileAnalysis,
    private readonly excludeFiles: ReadonlySet<string>,
  ) {}

  static create(document: vscode.TextDocument, project: ProjectHandle): ImportContext {
    const analysis = analyzeFile(document.getText());
    // `import "x.sol";` brings every symbol of x into scope.
    const excludeFiles = new Set<string>();
    for (const imp of analysis.imports) {
      if (imp.kind !== "plain") continue;
      const resolved = project.model.resolveImport(imp.path, document.uri.fsPath);
      const file = project.index.getFile(resolved);
      excludeFiles.add(file?.realPath ?? resolved);
    }
    return new ImportContext(document, project, analysis, excludeFiles);
  }

  candidates(options: Pick<CandidateQuery, "nameFilter" | "name"> = {}): ImportCandidate[] {
    return findImportCandidates({
      project: this.project.model,
      index: this.project.index,
      importerPath: this.document.uri.fsPath,
      pathStyle: readAutoImportPathStyle(this.document.uri),
      excludeNames: new Set([...this.analysis.declaredNames, ...this.analysis.importedNames]),
      excludeFiles: this.excludeFiles,
      ...options,
    });
  }

  /** The edit adding the import for a candidate, or undefined if nothing needs to change. */
  importEdit(candidate: ImportCandidate): vscode.TextEdit | undefined {
    const { model } = this.project;
    const importer = this.document.uri.fsPath;
    const target = model.resolveImport(candidate.importPath, importer);
    const change = computeImportEdit(this.analysis, {
      name: candidate.name,
      path: candidate.importPath,
      samePath: (existing) => existing === candidate.importPath || model.resolveImport(existing, importer) === target,
    });
    if (!change) return undefined;
    return new vscode.TextEdit(
      new vscode.Range(this.document.positionAt(change.start), this.document.positionAt(change.end)),
      change.newText,
    );
  }
}

export function importStatementFor(candidate: ImportCandidate, quote: '"' | "'"): string {
  return `import {${candidate.name}} from ${quote}${candidate.importPath}${quote};`;
}

export function completionKind(kind: SymbolKind): vscode.CompletionItemKind {
  switch (kind) {
    case "contract":
    case "abstract":
      return vscode.CompletionItemKind.Class;
    case "interface":
      return vscode.CompletionItemKind.Interface;
    case "library":
      return vscode.CompletionItemKind.Module;
    case "struct":
      return vscode.CompletionItemKind.Struct;
    case "enum":
      return vscode.CompletionItemKind.Enum;
    case "event":
      return vscode.CompletionItemKind.Event;
    case "error":
      // No dedicated kind exists for errors; they are declared like events.
      return vscode.CompletionItemKind.Event;
    case "type":
      return vscode.CompletionItemKind.TypeParameter;
    case "function":
      return vscode.CompletionItemKind.Function;
    case "constant":
      return vscode.CompletionItemKind.Constant;
  }
}

export function kindLabel(kind: SymbolKind): string {
  switch (kind) {
    case "abstract":
      return "abstract contract";
    case "type":
      return "user-defined value type";
    case "function":
      return "free function";
    default:
      return kind;
  }
}
