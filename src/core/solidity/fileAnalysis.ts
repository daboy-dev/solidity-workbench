import { braceDepths, extractSymbolsWithRegex } from "./extractSymbols";
import { blankTrivia, scanTrivia, type TriviaRange } from "./lexContext";

export interface ImportedSymbol {
  readonly name: string;
  readonly alias?: string;
}

export interface ImportStatement {
  /** Offset of `import`. */
  readonly start: number;
  /** Offset just after the terminating `;`. */
  readonly end: number;
  readonly path: string;
  readonly quote: '"' | "'";
  /**
   * named:     import {A, B as C} from "x";
   * plain:     import "x";               (brings every symbol of x into scope)
   * unitAlias: import "x" as X; / import * as X from "x";
   */
  readonly kind: "named" | "plain" | "unitAlias";
  readonly symbols: readonly ImportedSymbol[];
  readonly unitAlias?: string;
  /** Offsets of `{` and `}` for named imports. */
  readonly braces?: { readonly open: number; readonly close: number };
}

export interface FileAnalysis {
  readonly text: string;
  readonly trivia: readonly TriviaRange[];
  readonly imports: readonly ImportStatement[];
  /** End offset (after `;`) of the last top-level pragma, if any. */
  readonly pragmaEnd?: number;
  /** End offset of a leading `// SPDX-License-Identifier:` comment, if any. */
  readonly spdxEnd?: number;
  /** Names declared at file level. */
  readonly declaredNames: ReadonlySet<string>;
  /** Names brought into scope by named imports (aliases when present) and unit aliases. */
  readonly importedNames: ReadonlySet<string>;
  /** The quote style to use for new imports: the most common in existing imports, else double. */
  readonly preferredQuote: '"' | "'";
}

const IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";
// `import` followed by an optional {...} group and anything but braces up to `;`.
const IMPORT_RE = /\bimport\b(\s*\{[^{}]*\})?[^;{}]*;/g;
const PRAGMA_RE = /\bpragma\b[^;{}]*;/g;
const NAMED_RE = new RegExp(`^\\s*(${IDENT})(?:\\s+as\\s+(${IDENT}))?\\s*$`);
const UNIT_ALIAS_RE = new RegExp(`\\bas\\s+(${IDENT})`);

/** Analyses a (possibly incomplete) Solidity file without a full parse. */
export function analyzeFile(text: string): FileAnalysis {
  const trivia = scanTrivia(text);
  const clean = blankTrivia(text, trivia);
  const depthAt = braceDepths(clean);
  const depthZero = (offset: number) => depthAt(offset) === 0;

  const imports: ImportStatement[] = [];
  for (const m of clean.matchAll(IMPORT_RE)) {
    const start = m.index ?? 0;
    if (!depthZero(start)) continue;
    const parsed = parseImport(text, clean, trivia, start, start + m[0].length);
    if (parsed) imports.push(parsed);
  }

  let pragmaEnd: number | undefined;
  for (const m of clean.matchAll(PRAGMA_RE)) {
    if (depthZero(m.index ?? 0)) pragmaEnd = (m.index ?? 0) + m[0].length;
  }

  const first = trivia[0];
  const spdxEnd =
    first && first.kind === "lineComment" && /SPDX-License-Identifier/.test(text.slice(first.start, first.end)) && !/\S/.test(text.slice(0, first.start))
      ? first.end
      : undefined;

  const declaredNames = new Set(extractSymbolsWithRegex(text).map((s) => s.name));
  const importedNames = new Set<string>();
  for (const imp of imports) {
    for (const s of imp.symbols) importedNames.add(s.alias ?? s.name);
    if (imp.unitAlias) importedNames.add(imp.unitAlias);
  }

  const singles = imports.filter((i) => i.quote === "'").length;
  const preferredQuote = singles > imports.length - singles ? "'" : '"';

  return {
    text,
    trivia,
    imports,
    ...(pragmaEnd !== undefined ? { pragmaEnd } : {}),
    ...(spdxEnd !== undefined ? { spdxEnd } : {}),
    declaredNames,
    importedNames,
    preferredQuote,
  };
}

function parseImport(text: string, clean: string, trivia: readonly TriviaRange[], start: number, end: number): ImportStatement | undefined {
  const str = trivia.find((t) => t.kind === "string" && t.start >= start && t.end <= end && t.terminated);
  if (!str?.quote) return undefined;
  const path = text.slice(str.start + 1, str.end - 1);
  const head = clean.slice(start, str.start);
  const tail = clean.slice(str.end, end);

  const open = clean.indexOf("{", start);
  if (open >= 0 && open < str.start) {
    const close = clean.indexOf("}", open);
    if (close < 0 || close > str.start) return undefined;
    const symbols: ImportedSymbol[] = [];
    for (const part of clean.slice(open + 1, close).split(",")) {
      if (!part.trim()) continue;
      const nm = NAMED_RE.exec(part);
      if (nm) symbols.push(nm[2] ? { name: nm[1]!, alias: nm[2] } : { name: nm[1]! });
    }
    return { start, end, path, quote: str.quote, kind: "named", symbols, braces: { open, close } };
  }

  // import * as X from "x";  |  import "x" as X;
  const alias = UNIT_ALIAS_RE.exec(head) ?? UNIT_ALIAS_RE.exec(tail);
  if (alias) return { start, end, path, quote: str.quote, kind: "unitAlias", symbols: [], unitAlias: alias[1]! };
  return { start, end, path, quote: str.quote, kind: "plain", symbols: [] };
}
