import * as vscode from "vscode";
import { complete, type CompletionEntry, type EntryKind } from "../../core/completion/complete";
import { cursorContext } from "../../core/completion/cursorContext";
import { documentLanguageVersion } from "../../host/solc";
import type { WorkbenchCore } from "../../host/workbenchCore";
import { SOLIDITY_TEXT_SELECTOR, type Feature } from "../feature";

/** Language completion: types, keywords, variables in scope, members and globals. */
export const completionFeature: Feature = {
  id: "completion",
  activate(core: WorkbenchCore): vscode.Disposable {
    return vscode.languages.registerCompletionItemProvider(SOLIDITY_TEXT_SELECTOR, new LanguageCompletionProvider(core), ".");
  },
};

class LanguageCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly core: WorkbenchCore) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionList | undefined> {
    const offset = document.offsetAt(position);
    const ctx = cursorContext(this.core.structures.structure(document), offset);
    if (ctx.site.kind === "none") return undefined;
    const project = document.uri.scheme === "file" ? await this.core.projectFor(document.uri) : undefined;
    const version = await documentLanguageVersion(document, project);
    if (token.isCancellationRequested) return undefined;
    const entries = await complete(ctx, { version, path: document.uri.fsPath, host: this.core.structures.host(project) });
    if (token.isCancellationRequested || entries.length === 0) return undefined;

    const start = document.positionAt(ctx.prefixStart);
    const wordEnd = document.getWordRangeAtPosition(position, /[A-Za-z_$][\w$]*/)?.end ?? position;
    const range = { inserting: new vscode.Range(start, position), replacing: new vscode.Range(start, wordEnd) };
    const items = entries.map((e, i) => toItem(e, i, range));
    return new vscode.CompletionList(items, false);
  }
}

function toItem(e: CompletionEntry, index: number, range: { inserting: vscode.Range; replacing: vscode.Range }): vscode.CompletionItem {
  const item = new vscode.CompletionItem(e.detail ? { label: e.label, description: e.detail } : e.label, ITEM_KINDS[e.kind]);
  if (e.detail) item.detail = e.detail;
  if (e.documentation) item.documentation = new vscode.MarkdownString(e.documentation);
  if (e.deprecated) item.tags = [vscode.CompletionItemTag.Deprecated];
  if (e.snippet) item.insertText = new vscode.SnippetString(e.snippet);
  else if (e.insertText) item.insertText = e.insertText;
  // VS Code orders by fuzzy score, then by sortText: keep our priority order for ties.
  item.sortText = `${e.rank}${String(index).padStart(4, "0")}`;
  item.range = range;
  return item;
}

const ITEM_KINDS: Readonly<Record<EntryKind, vscode.CompletionItemKind>> = {
  keyword: vscode.CompletionItemKind.Keyword,
  type: vscode.CompletionItemKind.TypeParameter,
  variable: vscode.CompletionItemKind.Variable,
  parameter: vscode.CompletionItemKind.Variable,
  field: vscode.CompletionItemKind.Field,
  property: vscode.CompletionItemKind.Property,
  function: vscode.CompletionItemKind.Function,
  method: vscode.CompletionItemKind.Method,
  event: vscode.CompletionItemKind.Event,
  error: vscode.CompletionItemKind.Event,
  struct: vscode.CompletionItemKind.Struct,
  enum: vscode.CompletionItemKind.Enum,
  enumMember: vscode.CompletionItemKind.EnumMember,
  contract: vscode.CompletionItemKind.Class,
  interface: vscode.CompletionItemKind.Interface,
  library: vscode.CompletionItemKind.Module,
  modifier: vscode.CompletionItemKind.Function,
  constant: vscode.CompletionItemKind.Constant,
  unit: vscode.CompletionItemKind.Unit,
  namespace: vscode.CompletionItemKind.Module,
};
