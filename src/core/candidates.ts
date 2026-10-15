import type { SymbolIndex, IndexedFile, IndexedSymbol } from "./index/symbolIndex";
import type { ProjectArea, ProjectModel } from "./project/projectModel";
import { looksInferred, type Remapping } from "./project/remappings";
import type { SymbolKind } from "./solidity/symbols";

export type PathStyle = "remapped" | "relative";

export interface CandidateQuery {
  readonly project: ProjectModel;
  readonly index: SymbolIndex;
  /** Absolute path of the file that will receive the import. */
  readonly importerPath: string;
  readonly pathStyle: PathStyle;
  /** Names already declared or imported in the importer. */
  readonly excludeNames?: ReadonlySet<string>;
  /** Real paths whose symbols are already in scope (plain `import "x.sol";`). */
  readonly excludeFiles?: ReadonlySet<string>;
  /** Restricts the names considered (e.g. prefix filtering for completion). */
  readonly nameFilter?: (name: string) => boolean;
  /** Restricts to an exact name (quick fixes). */
  readonly name?: string;
}

export interface ImportCandidate {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly file: IndexedFile;
  readonly symbol: IndexedSymbol;
  readonly importPath: string;
  readonly viaRemapping: boolean;
  /** Lower is better; compares alternatives of the same name. */
  readonly rank: number;
  /** The contract, interface or library declaring a member (`IERC721Errors`). */
  readonly container?: string;
  /** What the import brings into scope: the symbol, or the container of a member. */
  readonly importName: string;
  /** What is written where it is used: `IERC721Errors.ERC721NonexistentToken` for a member. */
  readonly insertText: string;
  /** The container of a member is already in scope: nothing to import, only to qualify. */
  readonly containerInScope?: boolean;
}

/**
 * Lists importable symbols for a file, one per (name, real path, container):
 * - errors, events, structs and enums of contracts are offered qualified, importing their
 *   container (or not, when it is already in scope);
 * - files in test/ and script/ are hidden from files in src/;
 * - copies reached through symlinks collapse to one entry;
 * - alternatives for the same name are ranked: the project's own files and
 *   files reachable through a declared remapping first, then through an
 *   inferred one, then by relative path; within a tier, by nesting depth.
 */
export function findImportCandidates(q: CandidateQuery): ImportCandidate[] {
  const importerArea = q.project.areaOf(q.importerPath);
  const best = new Map<string, ImportCandidate>();
  const names = q.name !== undefined ? [q.name] : q.index.names();

  for (const name of names) {
    if (q.excludeNames?.has(name) || (q.nameFilter && !q.nameFilter(name))) continue;
    for (const symbol of q.index.lookup(name)) {
      const file = symbol.file;
      const { container } = symbol;
      const fileInScope = q.excludeFiles?.has(file.realPath) ?? false;
      if (file.path === q.importerPath || (fileInScope && !container)) continue;
      if (!isVisible(importerArea, file.area)) continue;

      const key = `${name}\u0000${file.realPath}\u0000${container ?? ""}`;
      const resolved = q.project.importPathFor(file.path, q.importerPath, q.pathStyle);
      const viaRemapping = resolved.remapping !== undefined;
      const containerInScope = container !== undefined && (fileInScope || (q.excludeNames?.has(container) ?? false));
      const candidate: ImportCandidate = {
        name,
        kind: symbol.kind,
        file,
        symbol,
        importPath: resolved.path,
        viaRemapping,
        // Members come after top-level symbols of the same name.
        rank: rankOf(q.project, file, resolved.remapping, resolved.path) + (container ? 10_000_000 : 0),
        importName: container ?? name,
        insertText: container ? `${container}.${name}` : name,
        ...(container ? { container } : {}),
        ...(containerInScope ? { containerInScope } : {}),
      };
      const existing = best.get(key);
      if (!existing || candidate.rank < existing.rank) best.set(key, candidate);
    }
  }
  return [...best.values()].sort(compareCandidates);
}

export function compareCandidates(a: ImportCandidate, b: ImportCandidate): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : a.rank - b.rank || (a.importPath < b.importPath ? -1 : 1);
}

function isVisible(importer: ProjectArea, candidate: ProjectArea): boolean {
  if (importer === "src") return candidate !== "test" && candidate !== "script";
  return true;
}

/**
 * Tier 0: one of the project's own files, or reachable through a declared remapping.
 * Tier 1: reachable through an inferred `name/=lib/name/...` remapping.
 * Tier 2: only reachable through a relative path into a library (e.g. nested copies).
 * Within a tier, fewer nested library levels and shorter paths win.
 */
function rankOf(project: ProjectModel, file: IndexedFile, remapping: Remapping | undefined, importPath: string): number {
  const tier = file.area !== "lib" ? 0 : remapping ? (looksInferred(remapping) ? 1 : 0) : 2;
  const sourceUnit = project.sourceUnitName(file.path);
  const segments = sourceUnit.split("/");
  const libDirs = new Set(project.config.libs);
  const libDepth = segments.filter((s) => libDirs.has(s)).length;
  return tier * 1_000_000 + libDepth * 10_000 + Math.min(segments.length, 99) * 100 + Math.min(importPath.length, 99);
}

/**
 * Case-insensitive subsequence test. VS Code's fuzzy matcher only accepts
 * names containing the typed characters in order, so this keeps a superset
 * of what the editor will show.
 */
export function subsequenceFilter(typed: string): (name: string) => boolean {
  const pattern = typed.toLowerCase();
  return (name) => {
    const lower = name.toLowerCase();
    let j = 0;
    for (let i = 0; i < lower.length && j < pattern.length; i++) if (lower[i] === pattern[j]) j++;
    return j === pattern.length;
  };
}

/**
 * Picks at most `max` candidates for a completion list, preferring names that
 * start with what was typed (case-sensitive, then insensitive), then shorter
 * names. Returns them in the stable name/rank order.
 */
export function selectForCompletion(candidates: readonly ImportCandidate[], typed: string, max: number): ImportCandidate[] {
  if (candidates.length <= max) return [...candidates];
  const lower = typed.toLowerCase();
  const score = (c: ImportCandidate) => (c.name.startsWith(typed) ? 0 : c.name.toLowerCase().startsWith(lower) ? 1 : 2);
  return [...candidates]
    .sort((a, b) => score(a) - score(b) || a.name.length - b.name.length || compareCandidates(a, b))
    .slice(0, max)
    .sort(compareCandidates);
}
