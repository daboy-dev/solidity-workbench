import * as vscode from "vscode";
import type { OutlineKind, OutlineNode } from "../../core/solidity/documentOutline";
import type { WorkbenchCore } from "../../host/workbenchCore";
import { SOLIDITY_TEXT_SELECTOR, type Feature } from "../feature";

/** Document outline: contracts with their functions, events, errors, variables... */
export const outlineFeature: Feature = {
  id: "outline",
  activate(core: WorkbenchCore): vscode.Disposable {
    return vscode.languages.registerDocumentSymbolProvider(SOLIDITY_TEXT_SELECTOR, new OutlineProvider(core), {
      label: "Solidity Workbench",
    });
  },
};

const MAX_ATTEMPTS = 3;

class OutlineProvider implements vscode.DocumentSymbolProvider {
  constructor(private readonly core: WorkbenchCore) {}

  async provideDocumentSymbols(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.DocumentSymbol[]> {
    // Retry when the document changed while it was being analysed, so offsets match the text.
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !token.isCancellationRequested; attempt++) {
      const { version, analysis } = await this.core.analyzeDocument(document);
      if (document.version === version) return analysis.outline.map((n) => toSymbol(document, n, true));
    }
    return [];
  }
}

function toSymbol(document: vscode.TextDocument, node: OutlineNode, topLevel: boolean): vscode.DocumentSymbol {
  const range = new vscode.Range(document.positionAt(node.start), document.positionAt(node.end));
  let selection = new vscode.Range(document.positionAt(node.nameStart), document.positionAt(node.nameEnd));
  // VS Code rejects symbols whose selection range is outside their range.
  if (!range.contains(selection)) selection = new vscode.Range(range.start, range.start);
  const symbol = new vscode.DocumentSymbol(node.name || "(anonymous)", node.detail, symbolKind(node.kind, topLevel), range, selection);
  symbol.children = node.children.map((c) => toSymbol(document, c, false));
  return symbol;
}

function symbolKind(kind: OutlineKind, topLevel: boolean): vscode.SymbolKind {
  switch (kind) {
    case "contract":
    case "abstract":
      return vscode.SymbolKind.Class;
    case "interface":
      return vscode.SymbolKind.Interface;
    case "library":
      return vscode.SymbolKind.Module;
    case "struct":
      return vscode.SymbolKind.Struct;
    case "enum":
      return vscode.SymbolKind.Enum;
    case "enumValue":
      return vscode.SymbolKind.EnumMember;
    case "event":
    case "error":
      return vscode.SymbolKind.Event;
    case "type":
      return vscode.SymbolKind.TypeParameter;
    case "function":
      return topLevel ? vscode.SymbolKind.Function : vscode.SymbolKind.Method;
    case "constructor":
      return vscode.SymbolKind.Constructor;
    case "fallback":
    case "receive":
    case "modifier":
      return vscode.SymbolKind.Method;
    case "stateVariable":
    case "field":
      return vscode.SymbolKind.Field;
    case "constant":
      return vscode.SymbolKind.Constant;
  }
}
