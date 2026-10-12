import * as vscode from "vscode";
import type { SyntaxProblem } from "../../core/solidity/syntaxCheck";
import type { WorkbenchCore } from "../../host/workbenchCore";
import { isSolidityDocument, SOLIDITY_TEXT_SELECTOR, type Feature } from "../feature";

export const DIAGNOSTIC_SOURCE = "solidity-workbench";
const CHANGE_DELAY_MS = 250;
const TYPO_FIX = /Did you mean `([A-Za-z]+)`\?/;

/** Syntax errors while typing: unbalanced brackets, misspelled keywords and parser errors. */
export const syntaxDiagnosticsFeature: Feature = {
  id: "syntaxDiagnostics",
  activate: (core) => new SyntaxDiagnostics(core),
};

class SyntaxDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("solidity-workbench-syntax");
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly core: WorkbenchCore) {
    this.disposables.push(
      this.collection,
      vscode.workspace.onDidOpenTextDocument((doc) => this.schedule(doc, 0)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0) this.schedule(e.document, CHANGE_DELAY_MS);
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => this.forget(doc.uri)),
      vscode.languages.registerCodeActionsProvider(SOLIDITY_TEXT_SELECTOR, new KeywordTypoFixProvider(), {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }),
    );
    for (const doc of vscode.workspace.textDocuments) this.schedule(doc, 0);
  }

  private schedule(document: vscode.TextDocument, delay: number): void {
    if (!isSolidityDocument(document)) return;
    const key = document.uri.toString();
    const previous = this.timers.get(key);
    if (previous) clearTimeout(previous);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.check(document);
      }, delay),
    );
  }

  private async check(document: vscode.TextDocument): Promise<void> {
    try {
      const { version, analysis } = await this.core.analyzeDocument(document);
      // A newer version is already scheduled; its offsets would not match.
      if (document.isClosed || document.version !== version) return;
      this.collection.set(document.uri, analysis.problems.map((p) => toDiagnostic(document, p)));
    } catch (err) {
      this.core.log.error(`Syntax check failed for ${document.uri.fsPath}`, err);
    }
  }

  private forget(uri: vscode.Uri): void {
    const key = uri.toString();
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.collection.delete(uri);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const d of this.disposables) d.dispose();
  }
}

function toDiagnostic(document: vscode.TextDocument, problem: SyntaxProblem): vscode.Diagnostic {
  const range = new vscode.Range(document.positionAt(problem.start), document.positionAt(problem.end));
  const diagnostic = new vscode.Diagnostic(range, problem.message, vscode.DiagnosticSeverity.Error);
  diagnostic.source = DIAGNOSTIC_SOURCE;
  diagnostic.code = problem.code;
  return diagnostic;
}

/** "Change to `contract`" for misspelled keywords. */
class KeywordTypoFixProvider implements vscode.CodeActionProvider {
  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== DIAGNOSTIC_SOURCE || diagnostic.code !== "keyword-typo") continue;
      const keyword = TYPO_FIX.exec(diagnostic.message)?.[1];
      if (!keyword) continue;
      const action = new vscode.CodeAction(`Change to \`${keyword}\``, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diagnostic];
      action.isPreferred = true;
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(document.uri, diagnostic.range, keyword);
      actions.push(action);
    }
    return actions;
  }
}
