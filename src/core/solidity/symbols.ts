/** Kinds of top-level (file-level) Solidity declarations that can be imported. */
export type SymbolKind =
  | "contract"
  | "abstract"
  | "interface"
  | "library"
  | "struct"
  | "enum"
  | "error"
  | "event"
  | "type"
  | "function"
  | "constant";

export const SYMBOL_KINDS: readonly SymbolKind[] = [
  "contract",
  "abstract",
  "interface",
  "library",
  "struct",
  "enum",
  "error",
  "event",
  "type",
  "function",
  "constant",
];

/** A declaration inside a file. Line and character are 0-based. */
export interface SymbolDeclaration {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly line: number;
  readonly character: number;
}

export type ExtractionMethod = "parser" | "regex" | "parser+regex";

export interface ExtractionResult {
  readonly symbols: SymbolDeclaration[];
  readonly method: ExtractionMethod;
}
