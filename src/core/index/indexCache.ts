import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { IndexedFile } from "./symbolIndex";

/** Bump when the shape of cached data or the extraction logic changes. */
export const CACHE_SCHEMA = 1;

interface CacheDocument {
  readonly schema: number;
  readonly root: string;
  readonly files: readonly IndexedFile[];
}

/** Loads cached entries for a project, keyed by path. Returns an empty map on any problem. */
export async function readIndexCache(cacheFile: string, root: string): Promise<Map<string, IndexedFile>> {
  const out = new Map<string, IndexedFile>();
  try {
    const doc = JSON.parse(await fs.readFile(cacheFile, "utf8")) as Partial<CacheDocument>;
    if (doc.schema !== CACHE_SCHEMA || doc.root !== root || !Array.isArray(doc.files)) return out;
    for (const f of doc.files) {
      if (f && typeof f.path === "string" && typeof f.mtimeMs === "number" && Array.isArray(f.symbols)) out.set(f.path, f);
    }
  } catch {
    // Missing or corrupt cache: start from scratch.
  }
  return out;
}

/** Writes the cache atomically (temp file + rename). */
export async function writeIndexCache(cacheFile: string, root: string, files: Iterable<IndexedFile>): Promise<void> {
  const doc: CacheDocument = { schema: CACHE_SCHEMA, root, files: [...files] };
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  const tmp = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(doc));
  await fs.rename(tmp, cacheFile);
}

/** Stable, filesystem-safe cache file name for a project root. */
export function cacheFileName(root: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < root.length; i++) {
    h ^= root.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const base = path.basename(root).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40) || "project";
  return `index-${base}-${h.toString(16).padStart(8, "0")}.json`;
}
