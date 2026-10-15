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
      const found = identifierAt(document, diagnostic.range);
      if (!found) continue;
      // `C.Err` written already: only `C` can be missing.
      const qualified = found.range.start.character > 0 && document.lineAt(found.range.start.line).text[found.range.start.character - 1] === ".";
      const candidates = ctx
        .candidates({ name: found.name })
        .filter((c) => !(qualified && c.container))
        .slice(0, MAX_ACTIONS_PER_DIAGNOSTIC);
      candidates.forEach((candidate, i) => {
        const key = `${candidate.insertText}\u0000${candidate.importPath}`;
        if (seen.has(key)) return;
        seen.add(key);
        const title = !candidate.container
          ? `Import ${candidate.name} from "${candidate.importPath}"`
          : candidate.containerInScope
            ? `Change to ${candidate.insertText}`
            : `Import ${candidate.container} from "${candidate.importPath}" and use ${candidate.insertText}`;
        const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = i === 0 && candidates.length === 1;
        const edits: vscode.TextEdit[] = [];
        // A member is used through its container: `ERC721NonexistentToken` → `IERC721Errors.ERC721NonexistentToken`.
        if (candidate.container) edits.push(vscode.TextEdit.replace(found.range, candidate.insertText));
        const edit = ctx.importEdit(candidate);
        if (edit) edits.push(edit);
        action.edit = new vscode.WorkspaceEdit();
        if (edits.length) action.edit.set(document.uri, edits);
        actions.push(action);
      });
    }
    return actions;
  }
}

/** The identifier a diagnostic points at (diagnostic ranges may be wider, e.g. `Foo.bar`). */
function identifierAt(document: vscode.TextDocument, range: vscode.Range): { name: string; range: vscode.Range } | undefined {
  const text = document.getText(range);
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) return { name: text, range };
  const word = document.getWordRangeAtPosition(range.start, IDENT_RE);
  return word ? { name: document.getText(word), range: word } : undefined;
}
