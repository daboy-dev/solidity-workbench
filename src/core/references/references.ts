import type { ReferenceIndex } from "./astIndex";
import { hierarchy, renameTarget } from "./rename";

/** Find All References and Document Highlight from solc's AST. */

export interface Reference {
  readonly file: string;
  readonly start: number;
  readonly end: number;
  readonly declaration: boolean;
}

/**
 * Every occurrence of the symbol at `offset` of `file`, in the project's own files:
 * uses (through import aliases too), named arguments, NatSpec tags, and the
 * declarations of the symbol and of what it overrides or is overridden by (also
 * when they are in libraries). On an import alias, its uses in that file.
 */
export function findReferences(index: ReferenceIndex, file: string, offset: number, text: string): Reference[] {
  const target = renameTarget(index, file, offset, text);
  if (!target) return [];
  const out: Reference[] = [];
  if (target.kind === "alias") {
    const alias = index.aliases.find((a) => a.file === file && a.local === target.local);
    if (alias) out.push({ file, start: alias.start, end: alias.end, declaration: true });
    for (const o of index.occurrences.get(file) ?? []) {
      if (o.key === target.key && text.slice(o.start, o.end) === target.local) out.push({ file, start: o.start, end: o.end, declaration: false });
    }
    return out;
  }
  const keys = new Set(hierarchy(index, target.decl.key));
  for (const [f, list] of index.occurrences) {
    for (const o of list) if (keys.has(o.key)) out.push({ file: f, start: o.start, end: o.end, declaration: o.kind === "declaration" });
  }
  // Declarations in libraries have no occurrence (library files are not indexed in detail).
  for (const k of keys) {
    const d = index.decls.get(k);
    if (d?.inLib) out.push({ file: d.file, start: d.nameStart, end: d.nameEnd, declaration: true });
  }
  return out;
}
