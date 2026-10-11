import * as vscode from "vscode";
import type { WorkbenchCore } from "../../host/workbenchCore";
import { ImportContext } from "./importContext";

/**
 * solc reports unknown names as error 7576 ("Undeclared identifier.") or
 * 7920 ("Identifier not found or not unique."). Every Solidity extension
 * forwards these, with or without the numeric code, so both are checked.
 */
const UNDECLARED_CODES = new Set(["7576", "7920"]);
const UNDECLARED_MESSAGE = /undeclared identifier|identifier not found or not unique|not found or not visible/i;
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/;
const MAX_ACTIONS_PER_DIAGNOSTIC = 5;

export function isUndeclaredIdentifier(diagnostic: vscode.Diagnostic): boolean {
  const code = typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code;
  return (code !== undefined && UNDECLARED_CODES.has(String(code))) || UNDECLARED_MESSAGE.test(diagnostic.message);
}

/** Offers "Import X from ..." quick fixes on undeclared identifier diagnostics. */
export class AutoImportCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] };

  constructor(private readonly core: WorkbenchCore) {}

  async provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeAction[]> {
    const diagnostics = context.diagnostics.filter(isUndeclaredIdentifier);
    if (diagnostics.length === 0) return [];
    const project = await this.core.projectFor(document.uri);
    if (!project || token.isCancellationRequested) return [];

    const ctx = ImportContext.create(document, project);
    const actions: vscode.CodeAction[] = [];
    const seen = new Set<string>();
    for (const diagnostic of diagnostics) {
      const name = identifierAt(document, diagnostic.range);
      if (!name) continue;
      const candidates = ctx.candidates({ name }).slice(0, MAX_ACTIONS_PER_DIAGNOSTIC);
      candidates.forEach((candidate, i) => {
        const key = `${candidate.name}\u0000${candidate.importPath}`;
        if (seen.has(key)) return;
        seen.add(key);
        const action = new vscode.CodeAction(`Import ${candidate.name} from "${candidate.importPath}"`, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = i === 0 && candidates.length === 1;
        const edit = ctx.importEdit(candidate);
        action.edit = new vscode.WorkspaceEdit();
        if (edit) action.edit.set(document.uri, [edit]);
        actions.push(action);
      });
    }
    return actions;
  }
}

/** The identifier a diagnostic points at (diagnostic ranges may be wider, e.g. `Foo.bar`). */
function identifierAt(document: vscode.TextDocument, range: vscode.Range): string | undefined {
  const text = document.getText(range);
  const exact = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text) ? text : undefined;
  if (exact) return exact;
  const word = document.getWordRangeAtPosition(range.start, IDENT_RE);
  return word ? document.getText(word) : undefined;
}
