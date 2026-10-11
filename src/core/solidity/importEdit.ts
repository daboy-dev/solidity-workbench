import type { FileAnalysis, ImportStatement } from "./fileAnalysis";

/** A text replacement in offsets of the analysed text. */
export interface TextChange {
  readonly start: number;
  readonly end: number;
  readonly newText: string;
}

export interface ImportRequest {
  readonly name: string;
  readonly path: string;
  /**
   * Decides whether an existing import path refers to the same file as
   * `path` (e.g. a relative and a remapped path to the same file). Defaults
   * to string equality.
   */
  readonly samePath?: (existingPath: string) => boolean;
}

/**
 * Computes the edit that makes `name` importable from `path`:
 * - nothing, if it is already imported by name from that file;
 * - merges into an existing `import {..} from "path"`;
 * - otherwise inserts a new line after the last import, or after the
 *   pragma (or SPDX header) separated by a blank line.
 * Uses the file's quote style and line endings.
 */
export function computeImportEdit(analysis: FileAnalysis, request: ImportRequest): TextChange | undefined {
  const same = request.samePath ?? ((p: string) => p === request.path);
  const named = analysis.imports.filter((i) => i.kind === "named" && same(i.path));
  if (named.some((i) => i.symbols.some((s) => s.name === request.name && !s.alias))) return undefined;

  const target = named.find((i) => i.braces);
  if (target) return mergeIntoImport(analysis.text, target, request.name);
  return insertNewImport(analysis, `import {${request.name}} from ${analysis.preferredQuote}${request.path}${analysis.preferredQuote};`);
}

function mergeIntoImport(text: string, imp: ImportStatement, name: string): TextChange {
  const { open, close } = imp.braces!;
  const inner = text.slice(open + 1, close);
  // Position just after the last non-whitespace character inside the braces.
  let last = close;
  while (last > open + 1 && /\s/.test(text[last - 1]!)) last--;

  if (last === open + 1) return { start: open + 1, end: close, newText: inner.includes("\n") ? inner : name };

  const trailingComma = text[last - 1] === ",";
  if (inner.includes("\n")) {
    // Multi-line list: one symbol per line, reusing the indentation of the last one.
    const lineStart = text.lastIndexOf("\n", last - 1) + 1;
    const indent = /^[ \t]*/.exec(text.slice(lineStart))![0];
    const eol = text[lineStart - 2] === "\r" ? "\r\n" : "\n";
    return trailingComma
      ? { start: last, end: last, newText: `${eol}${indent}${name},` }
      : { start: last, end: last, newText: `,${eol}${indent}${name}` };
  }
  return { start: last, end: last, newText: trailingComma ? ` ${name}` : `, ${name}` };
}

function insertNewImport(analysis: FileAnalysis, statement: string): TextChange {
  const { text } = analysis;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lastImport = analysis.imports.at(-1);

  if (lastImport && (analysis.pragmaEnd === undefined || lastImport.end >= analysis.pragmaEnd)) {
    const at = lineEnd(text, lastImport.end);
    return { start: at, end: at, newText: `${eol}${statement}` };
  }

  const anchor = analysis.pragmaEnd ?? analysis.spdxEnd;
  if (anchor === undefined) {
    // No header at all: put the import first, followed by a blank line if there is code.
    return { start: 0, end: 0, newText: `${statement}${eol}${/\S/.test(text) ? eol : ""}` };
  }
  const at = lineEnd(text, anchor);
  const nextLineHasCode = /^\r?\n[ \t]*\S/.test(text.slice(at));
  return { start: at, end: at, newText: `${eol}${eol}${statement}${nextLineHasCode ? eol : ""}` };
}

/** Offset of the end of the line containing `offset` (before `\r\n` or `\n`). */
function lineEnd(text: string, offset: number): number {
  let i = text.indexOf("\n", offset);
  if (i < 0) return text.length;
  if (i > 0 && text[i - 1] === "\r") i--;
  return Math.max(i, offset);
}
