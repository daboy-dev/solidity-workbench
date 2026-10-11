import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_FOUNDRY_CONFIG, parseFoundryConfig, type FoundryConfig } from "./foundryConfig";
import { loadRemappings, type RemappingOrigin, type RemappingSourceOptions } from "./remappingSource";
import { resolveImport, toImportPath, toSourceUnitName, type ImportPathResult, type Remapping } from "./remappings";

export const FOUNDRY_TOML = "foundry.toml";

/** Immutable snapshot of a Foundry project: root, configuration and remappings. */
export class ProjectModel {
  constructor(
    readonly root: string,
    readonly config: FoundryConfig,
    readonly remappings: readonly Remapping[],
    readonly remappingOrigin: RemappingOrigin,
    readonly hasFoundryToml: boolean,
  ) {}

  sourceUnitName(absPath: string): string {
    return toSourceUnitName(this.root, absPath);
  }

  absolutePath(sourceUnitName: string): string {
    return path.join(this.root, sourceUnitName);
  }

  contains(absPath: string): boolean {
    const rel = path.relative(this.root, absPath);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  importPathFor(targetAbs: string, importerAbs: string, style: "remapped" | "relative"): ImportPathResult {
    return toImportPath(this.remappings, this.sourceUnitName(targetAbs), this.sourceUnitName(importerAbs), style);
  }

  resolveImport(importPath: string, importerAbs: string): string {
    return this.absolutePath(resolveImport(this.remappings, importPath, this.sourceUnitName(importerAbs)));
  }

  /** Which top-level area of the project a file belongs to. */
  areaOf(absPath: string): ProjectArea {
    const rel = this.sourceUnitName(absPath);
    const under = (dir: string) => dir !== "." && (rel === dir || rel.startsWith(`${dir}/`));
    if (this.config.libs.some(under)) return "lib";
    if (under(this.config.test)) return "test";
    if (under(this.config.script)) return "script";
    if (under(this.config.src)) return "src";
    return "other";
  }
}

export type ProjectArea = "src" | "test" | "script" | "lib" | "other";

/**
 * Finds the nearest ancestor directory of `fromPath` that contains a
 * foundry.toml, never going above `ceiling`.
 */
export async function findProjectRoot(fromPath: string, ceiling: string): Promise<string | undefined> {
  let dir = path.dirname(fromPath);
  const stop = path.resolve(ceiling);
  for (;;) {
    if (await exists(path.join(dir, FOUNDRY_TOML))) return dir;
    if (path.resolve(dir) === stop) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function loadProject(root: string, options: RemappingSourceOptions = {}): Promise<ProjectModel> {
  let config = DEFAULT_FOUNDRY_CONFIG;
  let hasFoundryToml = false;
  try {
    const text = await fs.readFile(path.join(root, FOUNDRY_TOML), "utf8");
    config = parseFoundryConfig(text, process.env["FOUNDRY_PROFILE"] || "default");
    hasFoundryToml = true;
  } catch {
    // Not a Foundry project: defaults still give sensible src/test/lib layout.
  }
  const loaded = await loadRemappings(root, config, options);
  return new ProjectModel(root, config, loaded.remappings, loaded.origin, hasFoundryToml);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
