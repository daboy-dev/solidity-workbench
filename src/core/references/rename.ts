import * as path from "node:path";
import { importPathRange } from "../navigation/definitions";
import { analyzeFile } from "../solidity/fileAnalysis";
import type { IndexedDecl, Occurrence, ReferenceIndex } from "./astIndex";
import type { TextEdit } from "./locals";
import { invalidNameReason } from "./names";
import type { CompileGroup } from "./projectAst";

/** Rename of a declaration across the project, from solc's AST. */

export interface FileEdit extends TextEdit {
  /** Shown in the refactor preview: the symbol itself, or overrides / implementations of it. */
  readonly group: "symbol" | "hierarchy";
}

export interface RenamePlan {
  readonly oldName: string;
  /** Edits by absolute path. */
  readonly edits: Map<string, FileEdit[]>;
  /** The file to rename with the contract (`Vault.sol` → `Safe.sol`), and the import paths to update. */
  readonly file?: { readonly from: string; readonly to: string };
}

export type Target =
  | { readonly kind: "decl"; readonly decl: IndexedDecl; readonly start: number; readonly end: number }
  | { readonly kind: "alias"; readonly file: string; readonly local: string; readonly key: string; readonly start: number; readonly end: number };

/** The occurrence at `offset` of `file`, if any. */
export function occurrenceAt(index: ReferenceIndex, file: string, offset: number): Occurrence | undefined {
  const list = index.occurrences.get(file);
  if (!list) return undefined;
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const o = list[mid]!;
    if (o.end < offset) lo = mid + 1;
    else if (o.start > offset) hi = mid - 1;
    else return o;
  }
  return undefined;
}

/** What a rename at `offset` would rename: a declaration, or an import alias (`Y` in `{X as Y}`). */
export function renameTarget(index: ReferenceIndex, file: string, offset: number, text: string): Target | undefined {
  const alias = index.aliases.find((a) => a.file === file && a.start <= offset && offset <= a.end);
  if (alias) return { kind: "alias", file, local: alias.local, key: alias.key, start: alias.start, end: alias.end };
  const o = occurrenceAt(index, file, offset);
  const decl = o && index.decls.get(o.key);
  if (!o || !decl) return undefined;
  const written = text.slice(o.start, o.end);
  if (written !== decl.name) {
    const a = index.aliases.find((x) => x.file === file && x.local === written && x.key === decl.key);
    return a ? { kind: "alias", file, local: a.local, key: a.key, start: o.start, end: o.end } : undefined;
  }
  return { kind: "decl", decl, start: o.start, end: o.end };
}

/** The declaration and everything it overrides or is overridden by, transitively. */
export function hierarchy(index: ReferenceIndex, key: string): string[] {
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    (neighbours.get(a) ?? neighbours.set(a, new Set()).get(a)!).add(b);
    (neighbours.get(b) ?? neighbours.set(b, new Set()).get(b)!).add(a);
  };
  for (const [k, bases] of index.bases) for (const b of bases) link(k, b);
  const seen = new Set([key]);
  const queue = [key];
  while (queue.length) for (const n of neighbours.get(queue.pop()!) ?? []) if (!seen.has(n)) (seen.add(n), queue.push(n));
  return [...seen];
}

/**
 * Why the compilation cannot be trusted for a symbol of `file`: no solc, a failed
 * group, or a file that does not compile and imports `file` (it may use the symbol).
 */
export function compileProblem(groups: readonly CompileGroup[], file: string, rel: (abs: string) => string): string | undefined {
  const relevant = groups.filter((g) => g.closure.includes(file) || g.files.includes(file) || g.excluded.some((x) => x.closure.includes(file)));
  if (!relevant.length) return `${rel(file)} is not part of the project's sources (src, test, script).`;
  const describe = (e: CompileGroup["errors"][number]) => `${e.file ? `${rel(e.file)}:${e.line}:${e.column}: ` : ""}${e.message}`;
  for (const g of relevant) {
    if (g.requirement) return `No installed solc matches ${g.requirement} (needed by ${rel(g.files[0]!)}). Run \`forge build\` once to install it.`;
    if (g.failed) return `The project does not compile: ${g.errors[0] ? describe(g.errors[0]) : "solc produced no AST"}`;
    const user = g.excluded.find((x) => x.closure.includes(file));
    if (user) return `The project does not compile: ${describe(user.error)}`;
  }
  return undefined;
}

export type PlanResult = { readonly ok: true; readonly plan: RenamePlan } | { readonly ok: false; readonly reason: string };

export interface PlanContext {
  readonly index: ReferenceIndex;
  /** Current text of an own file. */
  readonly textOf: (abs: string) => string;
  readonly rel: (abs: string) => string;
  /** Whether a path exists (for the file rename). */
  readonly exists: (abs: string) => boolean;
}

export function planRename(ctx: PlanContext, target: Target, newName: string): PlanResult {
  const invalid = invalidNameReason(newName);
  if (invalid) return { ok: false, reason: invalid };
  const { index } = ctx;
  const edits = new Map<string, FileEdit[]>();
  const push = (file: string, e: FileEdit) => {
    const list = edits.get(file) ?? [];
    if (!list.some((x) => x.start === e.start)) list.push(e);
    edits.set(file, list);
  };

  if (target.kind === "alias") {
    push(target.file, { start: target.start, end: target.end, newText: newName, group: "symbol" });
    for (const o of index.occurrences.get(target.file) ?? []) {
      if (o.key === target.key && ctx.textOf(target.file).slice(o.start, o.end) === target.local) push(target.file, { start: o.start, end: o.end, newText: newName, group: "symbol" });
    }
    const alias = index.aliases.find((a) => a.file === target.file && a.local === target.local);
    if (alias) push(target.file, { start: alias.start, end: alias.end, newText: newName, group: "symbol" });
    return { ok: true, plan: { oldName: target.local, edits: sortEdits(edits) } };
  }

  const { decl } = target;
  const keys = hierarchy(index, decl.key);
  for (const k of keys) {
    const d = index.decls.get(k);
    if (d?.inLib) {
      const what = k === decl.key ? `\`${decl.name}\` is declared` : `\`${decl.name}\` overrides or implements \`${d.container ? `${d.container}.` : ""}${d.name}\`, declared`;
      return { ok: false, reason: `${what} in ${ctx.rel(d.file)}; library code is never renamed.` };
    }
  }
  const keySet = new Set(keys);
  for (const [file, list] of index.occurrences) {
    const text = ctx.textOf(file);
    for (const o of list) {
      if (!keySet.has(o.key)) continue;
      // Uses through an import alias (`Y` in `{X as Y}`) keep the alias.
      if (text.slice(o.start, o.end) !== decl.name) continue;
      push(file, { start: o.start, end: o.end, newText: newName, group: o.key === decl.key ? "symbol" : "hierarchy" });
    }
  }
  const plan: RenamePlan = { oldName: decl.name, edits: sortEdits(edits), ...contractFileRename(ctx, decl, newName) };
  return { ok: true, plan };
}

/** `Vault.sol` holding only `contract Vault` follows the contract's new name. */
function contractFileRename(ctx: PlanContext, decl: IndexedDecl, newName: string): { file?: { from: string; to: string } } {
  if (decl.nodeType !== "ContractDefinition" || path.basename(decl.file) !== `${decl.name}.sol`) return {};
  const declarations = ctx.index.topLevel.get(decl.file) ?? [];
  if (declarations.length !== 1 || declarations[0] !== decl.key) return {};
  const to = path.join(path.dirname(decl.file), `${newName}.sol`);
  return ctx.exists(to) ? {} : { file: { from: decl.file, to } };
}

function sortEdits(edits: Map<string, FileEdit[]>): Map<string, FileEdit[]> {
  for (const list of edits.values()) list.sort((a, b) => a.start - b.start);
  return edits;
}

/** Offset after applying `edits` (sorted) to the text before it. */
export function shifter(edits: readonly TextEdit[]): (offset: number) => number {
  return (offset) => {
    let d = 0;
    for (const e of edits) {
      if (e.end > offset) break;
      d += e.newText.length - (e.end - e.start);
    }
    return offset + d;
  };
}

/**
 * Checks a rename against the index of the renamed code: every reference must still
 * point to the same declaration (moved by the edits), and nothing else may refer to
 * the renamed one. Returns why not, or undefined.
 */
export function verifyRename(before: ReferenceIndex, after: ReferenceIndex, edits: ReadonlyMap<string, readonly TextEdit[]>, rel: (abs: string) => string, lineOf: (abs: string, offset: number) => number): string | undefined {
  const shifters = new Map<string, (o: number) => number>();
  const shift = (file: string, offset: number) => {
    let s = shifters.get(file);
    if (!s) shifters.set(file, (s = shifter(edits.get(file) ?? [])));
    return s(offset);
  };
  const movedKey = (key: string) => {
    const hash = key.lastIndexOf("#");
    const file = key.slice(0, hash);
    return `${file}#${shift(file, Number(key.slice(hash + 1)))}`;
  };
  for (const [file, list] of before.occurrences) {
    const afterList = after.occurrences.get(file) ?? [];
    const byStart = new Map<number, string[]>();
    for (const o of afterList) if (o.kind !== "natspec") (byStart.get(o.start) ?? byStart.set(o.start, []).get(o.start)!).push(o.key);
    let count = 0;
    for (const o of list) {
      if (o.kind === "natspec") continue;
      count++;
      const at = shift(file, o.start);
      if (!byStart.get(at)?.includes(movedKey(o.key))) {
        return `After renaming, the name at ${rel(file)}:${lineOf(file, at)} would refer to another declaration.`;
      }
    }
    const afterCount = afterList.filter((o) => o.kind !== "natspec").length;
    if (afterCount !== count) {
      const extra = afterList.find((o) => o.kind !== "natspec" && !list.some((b) => b.kind !== "natspec" && shift(file, b.start) === o.start));
      return `After renaming, a name at ${rel(file)}:${extra ? lineOf(file, extra.start) : "?"} would refer to the renamed declaration.`;
    }
  }
  return undefined;
}

/** Edits of the import paths that point to `from`, so that they point to `to` (same directory, new file name). */
export function importPathEdits(files: ReadonlyMap<string, string>, resolve: (importPath: string, importer: string) => string, from: string, to: string): Map<string, TextEdit[]> {
  const out = new Map<string, TextEdit[]>();
  const oldBase = path.basename(from);
  const newBase = path.basename(to);
  for (const [file, text] of files) {
    for (const imp of analyzeFile(text).imports) {
      if (resolve(imp.path, file) !== from || !imp.path.endsWith(oldBase)) continue;
      const range = importPathRange(imp, text);
      if (!range) continue;
      const list = out.get(file) ?? [];
      list.push({ start: range.end - oldBase.length, end: range.end, newText: newBase });
      out.set(file, list);
    }
  }
  return out;
}
