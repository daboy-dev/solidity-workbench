import { parse } from "@solidity-parser/parser";
import { blankTrivia } from "./lexContext";
import type { ExtractionResult, SymbolDeclaration, SymbolKind } from "./symbols";

/**
 * Extracts the top-level declarations of a Solidity file.
 *
 * Uses @solidity-parser/parser in tolerant mode. When parsing throws, or
 * reports errors (which may have made it skip declarations), the result is
 * completed with a regex scan over the comment-free text.
 */
export function extractSymbols(text: string): ExtractionResult {
  let parsed: SymbolDeclaration[] | undefined;
  let hadErrors = false;
  try {
    const ast = parse(text, { tolerant: true, loc: true });
    hadErrors = (ast.errors?.length ?? 0) > 0;
    parsed = [];
    for (const node of ast.children) {
      const decl = fromAstNode(node as unknown as AstNode);
      if (decl) parsed.push(decl);
    }
  } catch {
    parsed = undefined;
  }

  if (parsed && !hadErrors) return { symbols: parsed, method: "parser" };
  const scanned = extractSymbolsWithRegex(text);
  if (!parsed) return { symbols: scanned, method: "regex" };

  const seen = new Set(parsed.map((s) => `${s.kind}:${s.name}`));
  const merged = [...parsed, ...scanned.filter((s) => !seen.has(`${s.kind}:${s.name}`))];
  merged.sort((a, b) => a.line - b.line || a.character - b.character);
  return { symbols: merged, method: "parser+regex" };
}

interface AstNode {
  type: string;
  name?: string | null;
  kind?: string;
  isConstructor?: boolean;
  isFallback?: boolean;
  isReceiveEther?: boolean;
  loc?: { start: { line: number; column: number } };
}

function fromAstNode(node: AstNode): SymbolDeclaration | undefined {
  const kind = kindOf(node);
  if (!kind || !node.name) return undefined;
  return {
    name: node.name,
    kind,
    line: (node.loc?.start.line ?? 1) - 1,
    character: node.loc?.start.column ?? 0,
  };
}

function kindOf(node: AstNode): SymbolKind | undefined {
  switch (node.type) {
    case "ContractDefinition":
      switch (node.kind) {
        case "abstract":
          return "abstract";
        case "interface":
          return "interface";
        case "library":
          return "library";
        default:
          return "contract";
      }
    case "StructDefinition":
      return "struct";
    case "EnumDefinition":
      return "enum";
    case "CustomErrorDefinition":
      return "error";
    case "EventDefinition":
      return "event";
    case "TypeDefinition":
      return "type";
    case "FileLevelConstant":
      return "constant";
    case "FunctionDefinition":
      return node.isConstructor || node.isFallback || node.isReceiveEther ? undefined : "function";
    default:
      return undefined;
  }
}

const IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";
const DECL_RE = new RegExp(
  `\\b(?:(abstract)\\s+contract|(contract|interface|library|struct|enum|error|event|function))\\s+(${IDENT})|\\b(type)\\s+(${IDENT})\\s+is\\b|\\bconstant\\s+(${IDENT})\\s*=`,
  "g",
);

/** Regex fallback: finds declarations at brace depth 0, ignoring comments and strings. */
export function extractSymbolsWithRegex(text: string): SymbolDeclaration[] {
  const clean = blankTrivia(text);
  const depthAt = braceDepths(clean);
  const lineStarts = computeLineStarts(clean);
  const out: SymbolDeclaration[] = [];
  for (const m of clean.matchAll(DECL_RE)) {
    const index = m.index ?? 0;
    if (depthAt(index) !== 0) continue;
    let kind: SymbolKind;
    let name: string;
    let nameOffset: number;
    if (m[3]) {
      kind = m[1] ? "abstract" : (m[2] as SymbolKind);
      name = m[3];
    } else if (m[5]) {
      kind = "type";
      name = m[5];
    } else {
      kind = "constant";
      name = m[6]!;
    }
    // Constants are reported at their declaration statement start, like the parser does.
    nameOffset = kind === "constant" ? statementStart(clean, index) : index;
    const line = lineOf(lineStarts, nameOffset);
    out.push({ name, kind, line, character: nameOffset - lineStarts[line]! });
  }
  return out;
}

function braceDepths(text: string): (offset: number) => number {
  // Record depth changes so lookups are O(log n).
  const positions: number[] = [];
  const depths: number[] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x7b /* { */) depth++;
    else if (c === 0x7d /* } */) depth = Math.max(0, depth - 1);
    else continue;
    positions.push(i + 1);
    depths.push(depth);
  }
  return (offset) => {
    let lo = 0;
    let hi = positions.length - 1;
    let d = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (positions[mid]! <= offset) {
        d = depths[mid]!;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return d;
  };
}

function statementStart(text: string, index: number): number {
  let i = index;
  while (i > 0 && !";{}".includes(text[i - 1]!)) i--;
  while (i < index && /\s/.test(text[i]!)) i++;
  return i;
}

export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0x0a) starts.push(i + 1);
  return starts;
}

export function lineOf(lineStarts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
