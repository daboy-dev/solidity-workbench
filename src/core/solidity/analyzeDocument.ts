import { parse } from "@solidity-parser/parser";
import { computeLineStarts } from "./extractSymbols";
import { outlineFromAst, outlineFromRegex, type OutlineNode } from "./documentOutline";
import { blankTrivia, scanTrivia } from "./lexContext";
import { checkBrackets, checkKeywordTypos, describeParserError, type SyntaxProblem } from "./syntaxCheck";

export interface DocumentAnalysis {
  readonly outline: OutlineNode[];
  readonly problems: SyntaxProblem[];
  /** How the outline was obtained. */
  readonly outlineSource: "parser" | "regex";
}

interface ParserErrorItem {
  message: string;
  line: number;
  column: number;
}

/**
 * Analyses an open document: outline and syntax problems. Pure and
 * synchronous; runs in a worker thread.
 *
 * The parser crashes (rather than reporting errors) on some common mistakes,
 * so syntax problems combine:
 * - our own bracket and keyword-typo checks, which are precise and readable;
 * - the first error of the strict parser, when ours found nothing before it
 *   (later parser errors are mostly cascades of the first one).
 */
export function analyzeDocument(text: string): DocumentAnalysis {
  const trivia = scanTrivia(text);
  const clean = blankTrivia(text, trivia);

  let outline: OutlineNode[] | undefined;
  let tolerantErrors: ParserErrorItem[] | undefined;
  try {
    const ast = parse(text, { tolerant: true, loc: true, range: true });
    outline = outlineFromAst(text, ast.children);
    tolerantErrors = (ast.errors ?? []) as ParserErrorItem[];
  } catch {
    // The AST builder crashed after error recovery; use the fallbacks below.
  }

  const own = [...checkBrackets(clean), ...checkKeywordTypos(clean)].sort((a, b) => a.start - b.start);
  const parserErrors = tolerantErrors && tolerantErrors.length === 0 ? [] : strictParserErrors(text, tolerantErrors);
  const problems = [...own];
  const first = parserErrors[0];
  if (first) {
    const lineStarts = computeLineStarts(text);
    const problem = parserProblem(text, clean, lineStarts, first);
    const firstOwn = own[0];
    const sameLine = (a: number, b: number) => !/\n/.test(text.slice(Math.min(a, b), Math.max(a, b)));
    if (!firstOwn || (problem.start < firstOwn.start && !sameLine(problem.start, firstOwn.start))) problems.unshift(problem);
  }

  return outline ? { outline, problems, outlineSource: "parser" } : { outline: outlineFromRegex(text), problems, outlineSource: "regex" };
}

/** The strict parser reports more errors than the tolerant one, which may crash. */
function strictParserErrors(text: string, fallback: ParserErrorItem[] | undefined): ParserErrorItem[] {
  try {
    parse(text, { loc: true });
    return fallback ?? [];
  } catch (err) {
    const errors = (err as { errors?: ParserErrorItem[] }).errors;
    return Array.isArray(errors) && errors.length > 0 ? errors : (fallback ?? []);
  }
}

function parserProblem(text: string, clean: string, lineStarts: readonly number[], e: ParserErrorItem): SyntaxProblem {
  const lineStart = lineStarts[Math.max(0, e.line - 1)] ?? 0;
  let start = Math.min(text.length, lineStart + e.column);
  let message = describeParserError(e.message);
  // "Missing `;` before `x`": point at the end of the previous token, where the `;` belongs.
  if (message.startsWith("Missing ")) {
    message = message.replace(/ before .*$/, ".");
    let i = start;
    while (i > 0 && /\s/.test(clean[i - 1]!)) i--;
    start = Math.max(0, i - 1);
  }
  const token = /^[A-Za-z_$0-9]+/.exec(clean.slice(start))?.[0] ?? clean.slice(start, start + 1);
  return { start, end: Math.min(text.length, start + Math.max(1, token.length)), code: "parser", message };
}
