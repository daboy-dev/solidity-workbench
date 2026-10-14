import { parseStructure, type Callable, type Decl, type SourceStructure } from "../completion/structure";
import type { Token } from "../completion/tokens";
import { invalidNameReason } from "./names";

/**
 * Local variables and parameters (named returns, `for`, `try`/`catch` and tuple
 * declarations included) resolved with the tolerant parser: every use is bound
 * to the innermost visible declaration, so blocks and shadowing are respected,
 * also in half-written code. Inline assembly can refer to them too.
 */

export interface TextRange {
  readonly start: number;
  readonly end: number;
}

export interface TextEdit extends TextRange {
  readonly newText: string;
}

export interface LocalSymbol {
  readonly decl: Decl;
  /** The function, modifier or constructor it belongs to. */
  readonly callable: Callable | undefined;
  /** Where the declaration can be referred to (its scope, or the whole callable for parameters). */
  readonly region: TextRange;
  /** The name in the declaration. */
  readonly declaration: TextRange;
  /** The declaration and every use, in text order. */
  readonly occurrences: readonly TextRange[];
}

interface Binding {
  readonly decl: Decl;
  readonly region: TextRange;
  /** Size of the scope that declares it: the innermost one wins. */
  readonly depth: number;
  readonly callable: Callable | undefined;
}

interface LocalTable {
  /** Bindings by the offset of their declared name. */
  readonly byNameStart: Map<number, Binding>;
  readonly scopes: ReadonlyArray<{ readonly start: number; readonly end: number; readonly bindings: readonly Binding[] }>;
}

const tables = new WeakMap<SourceStructure, LocalTable>();

function table(structure: SourceStructure): LocalTable {
  let t = tables.get(structure);
  if (t) return t;
  const byNameStart = new Map<number, Binding>();
  const scopes: Array<{ start: number; end: number; bindings: Binding[] }> = [];
  const callableAt = (offset: number) => structure.callables.find((c) => c.start <= offset && offset <= c.end);
  for (const c of structure.callables) {
    const bindings: Binding[] = [];
    for (const decl of [...c.params, ...c.returns]) {
      if (!decl.name) continue;
      const b: Binding = { decl, region: { start: c.start, end: c.end }, depth: c.end - c.start + 1, callable: c };
      byNameStart.set(decl.nameStart, b);
      bindings.push(b);
    }
    scopes.push({ start: c.start, end: c.end, bindings });
  }
  // A declaration can be listed by nested scopes (a `for` variable is in the loop's scope and its
  // body's): it belongs to the outermost one.
  const sorted = [...structure.scopes].sort((a, b) => b.end - b.start - (a.end - a.start));
  for (const s of sorted) {
    const bindings: Binding[] = [];
    for (const decl of s.decls) {
      if (!decl.name) continue;
      let b = byNameStart.get(decl.nameStart);
      if (!b) {
        const region = { start: Math.min(s.start, decl.nameStart), end: s.end };
        b = { decl, region, depth: s.end - s.start, callable: callableAt(decl.nameStart) };
        byNameStart.set(decl.nameStart, b);
      }
      bindings.push(b);
    }
    scopes.push({ start: s.start, end: s.end, bindings });
  }
  t = { byNameStart, scopes };
  tables.set(structure, t);
  return t;
}

/** Index of the identifier token at `offset` (the cursor may also be just after it). */
function identifierAt(tokens: readonly Token[], offset: number): number {
  let lo = 0;
  let hi = tokens.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = tokens[mid]!;
    if (t.end < offset) lo = mid + 1;
    else if (t.start > offset) hi = mid - 1;
    else {
      // `a|.b`: prefer the identifier ending at the cursor over the punctuation starting there.
      if (t.kind === "ident") return mid;
      if (t.start === offset && mid > 0 && tokens[mid - 1]!.end === offset && tokens[mid - 1]!.kind === "ident") return mid - 1;
      if (t.end === offset && tokens[mid + 1]?.start === offset && tokens[mid + 1]!.kind === "ident") return mid + 1;
      return -1;
    }
  }
  return -1;
}

/** A name that cannot refer to a local: `x.member`, or the key of `f({key: value})` / `f{value: v}`. */
function isNotAReference(tokens: readonly Token[], i: number): boolean {
  const prev = tokens[i - 1];
  if (prev?.text === ".") return true;
  return tokens[i + 1]?.text === ":" && (prev?.text === "{" || prev?.text === ",");
}

function bindingOf(structure: SourceStructure, i: number): Binding | undefined {
  const { tokens } = structure;
  const tk = tokens[i];
  if (!tk || tk.kind !== "ident") return undefined;
  const t = table(structure);
  const declared = t.byNameStart.get(tk.start);
  if (declared) return declared.decl.name === tk.text ? declared : undefined;
  if (isNotAReference(tokens, i)) return undefined;
  let best: Binding | undefined;
  for (const s of t.scopes) {
    if (tk.start < s.start || tk.start > s.end) continue;
    for (const b of s.bindings) {
      if (b.decl.name !== tk.text) continue;
      // Parameters are visible in the whole callable, locals after their declaration statement.
      if (b.decl.kind === "local" && b.decl.visibleFrom > tk.start) continue;
      if (!best || b.depth < best.depth || (b.depth === best.depth && b.decl.nameStart > best.decl.nameStart)) best = b;
    }
  }
  return best;
}

/** The local variable or parameter named at `offset`, with all its occurrences. */
export function localSymbolAt(structure: SourceStructure, offset: number): LocalSymbol | undefined {
  const i = identifierAt(structure.tokens, offset);
  if (i < 0) return undefined;
  const binding = bindingOf(structure, i);
  return binding ? symbolOf(structure, binding) : undefined;
}

function symbolOf(structure: SourceStructure, binding: Binding): LocalSymbol {
  const { tokens } = structure;
  const { decl, region } = binding;
  const occurrences: TextRange[] = [];
  for (let k = firstTokenAt(tokens, region.start); k < tokens.length && tokens[k]!.start <= region.end; k++) {
    const tk = tokens[k]!;
    if (tk.text === decl.name && bindingOf(structure, k) === binding) occurrences.push({ start: tk.start, end: tk.end });
  }
  return {
    decl,
    callable: binding.callable,
    region,
    declaration: { start: decl.nameStart, end: decl.nameStart + decl.name.length },
    occurrences,
  };
}

function firstTokenAt(tokens: readonly Token[], offset: number): number {
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid]!.start < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type RenameResult = { readonly ok: true; readonly edits: readonly TextEdit[] } | { readonly ok: false; readonly reason: string };

/**
 * Edits renaming `symbol` to `newName`, including `@param` / `@return` tags of the
 * callable's NatSpec. Refused when the name is invalid, already declared in an
 * enclosing or enclosed scope of the same callable, or when the rename would
 * change what any identifier refers to.
 */
export function renameLocal(structure: SourceStructure, symbol: LocalSymbol, newName: string): RenameResult {
  const oldName = symbol.decl.name;
  if (newName === oldName) return { ok: true, edits: [] };
  const invalid = invalidNameReason(newName);
  if (invalid) return { ok: false, reason: invalid };

  const t = table(structure);
  const own = t.byNameStart.get(symbol.decl.nameStart)!;
  for (const other of t.byNameStart.values()) {
    if (other.decl.name !== newName || other.callable !== own.callable) continue;
    const a = own.region;
    const b = other.region;
    if ((a.start <= b.start && b.end <= a.end) || (b.start <= a.start && a.end <= b.end)) {
      return { ok: false, reason: `\`${newName}\` is already declared in this scope (line ${lineOf(structure.text, other.decl.nameStart)}).` };
    }
  }

  const edits: TextEdit[] = symbol.occurrences.map((o) => ({ ...o, newText: newName }));
  if (symbol.callable && (symbol.decl.kind === "parameter" || symbol.decl.kind === "return")) {
    edits.push(...natspecEdits(structure, symbol.callable.start, oldName, newName));
  }
  edits.sort((a, b) => a.start - b.start);

  // Apply the rename and check that exactly the renamed occurrences refer to the new declaration.
  const renamed = applyEdits(structure.text, edits);
  const after = parseStructure(renamed);
  const shift = (offset: number) => offset + edits.filter((e) => e.end <= offset).reduce((d, e) => d + e.newText.length - (e.end - e.start), 0);
  const expected = new Set(symbol.occurrences.map((o) => shift(o.start)));
  const newSymbol = localSymbolAt(after, shift(symbol.declaration.start));
  const found = newSymbol?.occurrences.map((o) => o.start) ?? [];
  const captured = found.find((o) => !expected.has(o));
  if (captured !== undefined) {
    return { ok: false, reason: `Renaming to \`${newName}\` would capture another \`${newName}\` (line ${lineOf(renamed, captured)}).` };
  }
  const lost = [...expected].find((o) => !found.includes(o));
  if (lost !== undefined) {
    return { ok: false, reason: `After renaming, \`${newName}\` at line ${lineOf(renamed, lost)} would refer to another declaration.` };
  }
  return { ok: true, edits };
}

/** `@param old` and `@return old` in the NatSpec comments right before the callable at `start`. */
function natspecEdits(structure: SourceStructure, start: number, oldName: string, newName: string): TextEdit[] {
  const { text, trivia } = structure;
  const edits: TextEdit[] = [];
  let end = start;
  for (let k = trivia.length - 1; k >= 0; k--) {
    const c = trivia[k]!;
    if (c.end > end) continue;
    if (c.kind === "string" || text.slice(c.end, end).trim() !== "") break;
    end = c.start;
    const comment = text.slice(c.start, c.end);
    if (!/^(\/\/\/|\/\*\*)/.test(comment)) continue;
    const tag = /@(?:param|return)[ \t]+([A-Za-z_$][\w$]*)/g;
    for (let m = tag.exec(comment); m; m = tag.exec(comment)) {
      if (m[1] !== oldName) continue;
      const at = c.start + m.index + m[0].length - oldName.length;
      edits.push({ start: at, end: at + oldName.length, newText: newName });
    }
  }
  return edits;
}

export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let out = "";
  let last = 0;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    out += text.slice(last, e.start) + e.newText;
    last = e.end;
  }
  return out + text.slice(last);
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 0x0a) line++;
  return line;
}
