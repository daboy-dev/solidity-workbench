import * as vscode from "vscode";
import { selectForCompletion, subsequenceFilter } from "../../core/candidates";
import { namesInScope } from "../../core/completion/complete";
import { cursorContext } from "../../core/completion/cursorContext";
import { BASELINE_VERSION } from "../../core/completion/languageVersion";
import { isInCommentOrString } from "../../core/solidity/lexContext";
import type { WorkbenchCore } from "../../host/workbenchCore";
import { completionKind, ImportContext, importStatementFor, kindLabel } from "./importContext";

/** Upper bound on items per request. */
const MAX_ITEMS = 400;
const WORD_RE = /[A-Za-z_$][A-Za-z0-9_$]*/;

/**
 * Suggests indexed symbols that are not yet in scope and adds the import
 * through additionalTextEdits. Edits are computed eagerly: resolving them
 * lazily would risk the item being inserted before the edit is known.
 */
export class AutoImportCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly core: WorkbenchCore) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionList | undefined> {
    const wordRange = document.getWordRangeAtPosition(position, WORD_RE);
    const start = wordRange?.start ?? position;
    const prefix = document.getText(new vscode.Range(start, position));
    if (!prefix) return undefined;
    if (!isIdentifierContext(document, start)) return undefined;

    const project = await this.core.projectFor(document.uri);
    if (!project || token.isCancellationRequested) return undefined;

    const ctx = ImportContext.create(document, project);
    if (isInCommentOrString(ctx.analysis.trivia, document.offsetAt(position))) return undefined;
    if (isInsideImportOrPragma(ctx, document.offsetAt(start))) return undefined;

    // A name already in scope (a local, an inherited member, a transitive plain import) needs no import.
    const cursor = cursorContext(this.core.structures.structure(document), document.offsetAt(position));
    const inScope = await namesInScope(cursor, { version: BASELINE_VERSION, path: document.uri.fsPath, host: this.core.structures.host(project) });
    if (token.isCancellationRequested) return undefined;
    const all = ctx.candidates({ nameFilter: subsequenceFilter(prefix) }, inScope);
    const candidates = selectForCompletion(all, prefix, MAX_ITEMS);

    const items: vscode.CompletionItem[] = [];
    const replacing = new vscode.Range(start, wordRange?.end ?? position);
    const inserting = new vscode.Range(start, position);
    for (const c of candidates) {
      if (token.isCancellationRequested) break;
      const item = new vscode.CompletionItem({ label: c.name, description: c.importPath }, completionKind(c.kind));
      item.detail = `${kindLabel(c.kind)} — auto import`;
      item.documentation = new vscode.MarkdownString().appendCodeblock(importStatementFor(c, ctx.analysis.preferredQuote), "solidity");
      item.insertText = c.name;
      item.filterText = c.name;
      item.range = { inserting, replacing };
      // Ties on the fuzzy score are broken by name, then by our ranking of alternative paths. The
      // leading 9 lists them after language completions (types, scope, globals) on equal scores.
      item.sortText = `9${c.name}\u0000${String(c.rank).padStart(8, "0")}`;
      const edit = ctx.importEdit(c);
      if (edit) item.additionalTextEdits = [edit];
      items.push(item);
    }
    // The result for a prefix contains every match of longer prefixes, so VS Code only
    // needs to ask again when the list was truncated or the first build is still running.
    return new vscode.CompletionList(items, all.length > candidates.length || project.indexing);
  }
}

/** Excludes member accesses such as `Foo.bar` and number literals. */
function isIdentifierContext(document: vscode.TextDocument, start: vscode.Position): boolean {
  const before = document.lineAt(start.line).text.slice(0, start.character);
  return !/\.\s*$/.test(before) && !/\d$/.test(before);
}

function isInsideImportOrPragma(ctx: ImportContext, offset: number): boolean {
  if (ctx.analysis.imports.some((i) => offset >= i.start && offset <= i.end)) return true;
  // Incomplete statements have no `;` yet: look at the current line.
  const lineStart = ctx.analysis.text.lastIndexOf("\n", offset - 1) + 1;
  return /^\s*(import|pragma)\b/.test(ctx.analysis.text.slice(lineStart, offset));
}
