import * as path from "node:path";

/**
 * A solc/forge import remapping: `[context:]prefix=target`.
 *
 * All paths are "source unit names": POSIX paths relative to the project
 * root, exactly as forge prints them (e.g. `lib/openzeppelin-contracts/contracts/`).
 */
export interface Remapping {
  readonly context: string;
  readonly prefix: string;
  readonly target: string;
}

export function parseRemapping(line: string): Remapping | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return undefined;
  const left = trimmed.slice(0, eq).trim();
  const target = trimmed.slice(eq + 1).trim();
  if (!target) return undefined;
  const colon = left.indexOf(":");
  const context = colon >= 0 ? left.slice(0, colon).trim() : "";
  const prefix = colon >= 0 ? left.slice(colon + 1).trim() : left;
  if (!prefix) return undefined;
  return { context: normalizeDir(context, false), prefix, target: normalizeDir(target, prefix.endsWith("/")) };
}

export function parseRemappingsText(text: string): Remapping[] {
  const out: Remapping[] = [];
  for (const line of text.split(/\r?\n/)) {
    const r = parseRemapping(line);
    if (r) out.push(r);
  }
  return out;
}

export function formatRemapping(r: Remapping): string {
  return `${r.context ? `${r.context}:` : ""}${r.prefix}=${r.target}`;
}

/** Strips `./`, converts backslashes and keeps a trailing slash when requested. */
function normalizeDir(p: string, trailingSlash: boolean): string {
  if (!p) return p;
  let s = toPosix(p).replace(/^\.\/+/, "");
  if (trailingSlash && !s.endsWith("/")) s += "/";
  return s;
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Source unit name of an absolute file path relative to the project root. */
export function toSourceUnitName(root: string, absPath: string): string {
  return toPosix(path.relative(root, absPath));
}

function appliesTo(r: Remapping, importer: string | undefined): boolean {
  return r.context === "" || (importer !== undefined && importer.startsWith(r.context));
}

/**
 * Resolves an import path the way solc does: among remappings whose context
 * matches the importing file, the longest context wins, then the longest prefix.
 * Relative imports (`./`, `../`) are resolved against the importer's directory.
 */
export function resolveImport(remappings: readonly Remapping[], importPath: string, importer?: string): string {
  if ((importPath.startsWith("./") || importPath.startsWith("../")) && importer !== undefined) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(importer), importPath));
  }
  let best: Remapping | undefined;
  for (const r of remappings) {
    if (!appliesTo(r, importer) || !importPath.startsWith(r.prefix)) continue;
    if (
      !best ||
      r.context.length > best.context.length ||
      (r.context.length === best.context.length && r.prefix.length > best.prefix.length)
    ) {
      best = r;
    }
  }
  return best ? best.target + importPath.slice(best.prefix.length) : importPath;
}

export interface ImportPathResult {
  readonly path: string;
  /** The remapping used, or undefined when the path is relative. */
  readonly remapping?: Remapping;
}

/**
 * Inverse of {@link resolveImport}: given the target source unit name, finds the
 * import path to write from `importer`. Prefers the remapping with the longest
 * target that contains the file, and only accepts candidates that round-trip
 * (resolve back to the same file). Falls back to a relative path.
 */
export function toImportPath(
  remappings: readonly Remapping[],
  target: string,
  importer: string,
  style: "remapped" | "relative" = "remapped",
): ImportPathResult {
  if (style === "remapped") {
    const candidates = remappings
      .filter((r) => appliesTo(r, importer) && target.startsWith(r.target))
      .sort(
        (a, b) =>
          b.target.length - a.target.length ||
          b.context.length - a.context.length ||
          Number(looksInferred(a)) - Number(looksInferred(b)),
      );
    for (const r of candidates) {
      const candidate = r.prefix + target.slice(r.target.length);
      if (resolveImport(remappings, candidate, importer) === target) return { path: candidate, remapping: r };
    }
  }
  return { path: relativeImport(importer, target) };
}

/**
 * `name/=lib/name/src/` style remappings are what forge infers automatically.
 * When a library also declares its own (e.g. `@openzeppelin/contracts/`), the
 * declared one is the canonical import path.
 */
function looksInferred(r: Remapping): boolean {
  const name = r.prefix.replace(/\/$/, "");
  return r.target.split("/").includes(name);
}

export function relativeImport(importer: string, target: string): string {
  const rel = path.posix.relative(path.posix.dirname(importer), target);
  return rel.startsWith("../") ? rel : `./${rel}`;
}

/**
 * Merges remapping lists. Earlier lists have priority: a remapping with the
 * same context and prefix as one already present is dropped.
 */
export function mergeRemappings(...lists: readonly (readonly Remapping[])[]): Remapping[] {
  const seen = new Set<string>();
  const out: Remapping[] = [];
  for (const list of lists) {
    for (const r of list) {
      const key = `${r.context}:${r.prefix}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}
