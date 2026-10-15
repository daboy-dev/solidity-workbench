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
  /**
   * For errors, events, structs and enums declared in a contract, interface or library: its
   * name. They are used qualified (`IERC721Errors.ERC721NonexistentToken`) by importing it.
   */
  readonly container?: string;
}

/** Kinds of contract members that are indexed, to be used qualified from other files. */
export const MEMBER_KINDS: ReadonlySet<SymbolKind> = new Set(["struct", "enum", "error", "event"]);

export type ExtractionMethod = "parser" | "regex" | "parser+regex";

export interface ExtractionResult {
  readonly symbols: SymbolDeclaration[];
  readonly method: ExtractionMethod;
}
