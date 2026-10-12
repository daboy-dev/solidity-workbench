import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runForge, type Env, type ExecFn } from "../foundry/forge";
import { parseFoundryConfig, type FoundryConfig } from "./foundryConfig";
import { mergeRemappings, parseRemapping, parseRemappingsText, toPosix, type Remapping } from "./remappings";

export type RemappingOrigin = "forge" | "files";

export interface LoadedRemappings {
  readonly remappings: Remapping[];
  readonly origin: RemappingOrigin;
  /** The forge executable that produced the remappings, when origin is "forge". */
  readonly forge?: string;
  /** Why forge was not used, when origin is "files". */
  readonly forgeError?: string;
}

export interface RemappingSourceOptions {
  /** Runs a command and resolves with stdout. Injected for tests. */
  readonly exec?: ExecFn;
  /** Path or name of the forge binary. */
  readonly forgePath?: string;
  /** Skip forge entirely (tests, or when the user disables it). */
  readonly useForge?: boolean;
  /** Environment used to locate forge (FOUNDRY_DIR, HOME). Injected for tests. */
  readonly env?: Env;
}

const MAX_LIB_DEPTH = 4;

/**
 * Loads remappings for a Foundry project: `forge remappings` when available,
 * otherwise the project's remappings.txt and foundry.toml plus forge-style
 * inference over the library directories.
 */
export async function loadRemappings(
  root: string,
  config: FoundryConfig,
  options: RemappingSourceOptions = {},
): Promise<LoadedRemappings> {
  let forgeError: string | undefined;
  if (options.useForge !== false) {
    try {
      const { forge, stdout } = await runForge(["remappings"], root, options);
      return { remappings: parseRemappingsText(stdout).map((r) => relativizeTarget(root, r)), origin: "forge", forge };
    } catch (err) {
      forgeError = err instanceof Error ? err.message : String(err);
    }
  }
  const project = mergeRemappings(config.remappings, parseRemappingsText(await readText(path.join(root, "remappings.txt"))));
  const inferred = await inferLibRemappings(root, "", config.libs, 0, true);
  return {
    remappings: [...project, ...resolveInferred(project, inferred)],
    origin: "files",
    ...(forgeError !== undefined ? { forgeError } : {}),
  };
}

/** forge may print absolute targets; store them relative to the root. */
function relativizeTarget(root: string, r: Remapping): Remapping {
  if (!path.isAbsolute(r.target)) return r;
  const rel = toPosix(path.relative(root, r.target));
  return { ...r, target: r.target.endsWith("/") && !rel.endsWith("/") ? `${rel}/` : rel };
}

interface InferredRemapping {
  readonly remapping: Remapping;
  /** The library containing the one this remapping comes from ("" for top-level libraries). */
  readonly parent: string;
  readonly depth: number;
}

/**
 * Mimics forge's remapping auto-detection (checked against forge 1.x):
 * - every library gets `name/` → `lib/name/src/` (or `contracts/`, or its root
 *   when it has no lib/ folder of its own);
 * - the remappings a library declares (remappings.txt, foundry.toml) are only
 *   read when the library, and every library above it, has a foundry.toml;
 * - nested libraries are visited recursively.
 * Results are ordered shallowest first and, within a depth, declared before inferred.
 */
async function inferLibRemappings(
  root: string,
  base: string,
  libs: readonly string[],
  depth: number,
  readDeclared: boolean,
): Promise<InferredRemapping[]> {
  if (depth >= MAX_LIB_DEPTH) return [];
  const declared: InferredRemapping[] = [];
  const auto: InferredRemapping[] = [];
  const deeper: InferredRemapping[][] = [];

  for (const lib of libs) {
    const libDir = joinRel(base, lib);
    for (const name of await listDirs(path.join(root, libDir))) {
      const pkg = joinRel(libDir, name);
      const pkgAbs = path.join(root, pkg);

      const tomlText = await readText(path.join(pkgAbs, "foundry.toml"));
      const isFoundryProject = readDeclared && tomlText !== "";
      const pkgConfig = tomlText ? parseFoundryConfig(tomlText) : undefined;
      if (isFoundryProject) {
        const own = [...(pkgConfig?.remappings ?? []), ...parseRemappingsText(await readText(path.join(pkgAbs, "remappings.txt")))];
        for (const r of own) declared.push({ remapping: rebase(pkg, r), parent: base, depth });
      }

      // Without src/ or contracts/, forge maps the library root, unless it only
      // wraps its own dependencies (it has a lib/ folder).
      let target: string | undefined;
      if (await isDir(path.join(pkgAbs, "src"))) target = `${pkg}/src/`;
      else if (await isDir(path.join(pkgAbs, "contracts"))) target = `${pkg}/contracts/`;
      else if (!(await isDir(path.join(pkgAbs, "lib")))) target = `${pkg}/`;
      if (target) auto.push({ remapping: { context: "", prefix: `${name}/`, target }, parent: base, depth });

      deeper.push(await inferLibRemappings(root, pkg, pkgConfig?.libs ?? ["lib"], depth + 1, isFoundryProject));
    }
  }
  return [...declared, ...auto, ...deeper.flat().sort((a, b) => a.depth - b.depth)];
}

/**
 * Combines inferred remappings the way forge does: a prefix defined by the
 * project itself hides every inferred one; otherwise the shallowest wins, and
 * a deeper library whose prefix is taken keeps it scoped to its parent library
 * (`lib/parent/:prefix=target`).
 */
function resolveInferred(project: readonly Remapping[], inferred: readonly InferredRemapping[]): Remapping[] {
  const projectPrefixes = new Set(project.map((r) => r.prefix));
  const global = new Set<string>();
  const scoped = new Set<string>();
  const out: Remapping[] = [];
  for (const { remapping: r, parent } of inferred) {
    if (projectPrefixes.has(r.prefix)) continue;
    if (!global.has(r.prefix)) {
      global.add(r.prefix);
      out.push(r);
      continue;
    }
    if (!parent) continue;
    const context = `${parent}/`;
    const key = `${context}:${r.prefix}`;
    if (scoped.has(key)) continue;
    scoped.add(key);
    out.push({ ...r, context });
  }
  return out;
}

/**
 * Remappings declared inside a library are relative to that library. forge
 * makes them global (dropping the context), which is what lets OpenZeppelin's
 * `@openzeppelin/contracts/=contracts/` work from the root project.
 */
function rebase(pkg: string, r: Remapping): Remapping {
  let target = path.isAbsolute(r.target) ? r.target : joinRel(pkg, r.target);
  if (r.target.endsWith("/") && !target.endsWith("/")) target += "/";
  const rebased = parseRemapping(`${r.prefix}=${target}`);
  return rebased ?? r;
}

function joinRel(a: string, b: string): string {
  return a ? path.posix.join(a, b) : path.posix.normalize(b);
}

async function readText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
