import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_FOUNDRY_CONFIG, parseFoundryConfig, type FoundryConfig } from "./foundryConfig";
import { loadRemappings, type RemappingOrigin, type RemappingSourceOptions } from "./remappingSource";
import { resolveImport, toImportPath, toPosix, toSourceUnitName, type ImportPathResult, type Remapping } from "./remappings";

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
 * Finds the Foundry project a file belongs to: the nearest ancestor with a
 * foundry.toml, never going above `ceiling`. A foundry.toml that lives inside
 * an enclosing project's library directory (e.g. lib/openzeppelin-contracts)
 * belongs to a dependency, so the enclosing project wins.
 */
export async function findProjectRoot(fromPath: string, ceiling: string): Promise<string | undefined> {
  const found: string[] = []; // innermost first
  let dir = path.dirname(fromPath);
  const stop = path.resolve(ceiling);
  for (;;) {
    if (await exists(path.join(dir, FOUNDRY_TOML))) found.push(dir);
    if (path.resolve(dir) === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (found.length === 0) return undefined;

  found.reverse();
  let current = found[0]!;
  for (const inner of found.slice(1)) {
    const libs = (await readConfig(current)).libs;
    const rel = toPosix(path.relative(current, inner));
    const isDependency = libs.some((l) => rel === l || rel.startsWith(`${l}/`)) || rel.split("/").includes("node_modules");
    if (isDependency) break;
    current = inner;
  }
  return current;
}

async function readConfig(root: string): Promise<FoundryConfig> {
  try {
    return parseFoundryConfig(await fs.readFile(path.join(root, FOUNDRY_TOML), "utf8"), process.env["FOUNDRY_PROFILE"] || "default");
  } catch {
    return DEFAULT_FOUNDRY_CONFIG;
  }
}

export async function loadProject(root: string, options: RemappingSourceOptions = {}): Promise<ProjectModel> {
  // Without a foundry.toml the defaults still give a sensible src/test/lib layout.
  const hasFoundryToml = await exists(path.join(root, FOUNDRY_TOML));
  const config = hasFoundryToml ? await readConfig(root) : DEFAULT_FOUNDRY_CONFIG;
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
