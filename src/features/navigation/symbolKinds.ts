import * as vscode from "vscode";
import type { SymbolKind } from "../../core/solidity/symbols";

export function symbolKindOf(kind: SymbolKind): vscode.SymbolKind {
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
    case "event":
    case "error":
      return vscode.SymbolKind.Event;
    case "type":
      return vscode.SymbolKind.TypeParameter;
    case "function":
      return vscode.SymbolKind.Function;
    case "constant":
      return vscode.SymbolKind.Constant;
  }
}
