import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseFoundryConfig, type FoundryConfig } from "./foundryConfig";
import { mergeRemappings, parseRemapping, parseRemappingsText, toPosix, type Remapping } from "./remappings";

export type RemappingOrigin = "forge" | "files";

export interface LoadedRemappings {
  readonly remappings: Remapping[];
  readonly origin: RemappingOrigin;
  /** Why forge was not used, when origin is "files". */
  readonly forgeError?: string;
}

export type ExecFn = (command: string, args: readonly string[], cwd: string) => Promise<string>;

export interface RemappingSourceOptions {
  /** Runs a command and resolves with stdout. Injected for tests. */
  readonly exec?: ExecFn;
  /** Path or name of the forge binary. */
  readonly forgePath?: string;
  /** Skip forge entirely (tests, or when the user disables it). */
  readonly useForge?: boolean;
}

const FORGE_TIMEOUT_MS = 15_000;
const MAX_LIB_DEPTH = 4;

export const defaultExec: ExecFn = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], { cwd, timeout: FORGE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

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
      const stdout = await (options.exec ?? defaultExec)(options.forgePath || "forge", ["remappings"], root);
      return { remappings: parseRemappingsText(stdout).map((r) => relativizeTarget(root, r)), origin: "forge" };
    } catch (err) {
      forgeError = err instanceof Error ? err.message : String(err);
    }
  }
  const fromFile = parseRemappingsText(await readText(path.join(root, "remappings.txt")));
  const inferred = await inferLibRemappings(root, "", config.libs, 0);
  return {
    remappings: mergeRemappings(config.remappings, fromFile, ...inferred),
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

/**
 * Mimics forge's remapping auto-detection. Returns one list per depth, from
 * shallowest to deepest, so callers can merge with shallower ones taking priority.
 * Within a depth, remappings declared by a library win over inferred `name/` ones.
 */
async function inferLibRemappings(
  root: string,
  base: string,
  libs: readonly string[],
  depth: number,
): Promise<Remapping[][]> {
  if (depth >= MAX_LIB_DEPTH) return [];
  const declared: Remapping[] = [];
  const auto: Remapping[] = [];
  const deeper: Remapping[][][] = [];

  for (const lib of libs) {
    const libDir = joinRel(base, lib);
    for (const name of await listDirs(path.join(root, libDir))) {
      const pkg = joinRel(libDir, name);
      const pkgAbs = path.join(root, pkg);

      const tomlText = await readText(path.join(pkgAbs, "foundry.toml"));
      const pkgConfig = tomlText ? parseFoundryConfig(tomlText) : undefined;
      const own = [
        ...(pkgConfig?.remappings ?? []),
        ...parseRemappingsText(await readText(path.join(pkgAbs, "remappings.txt"))),
      ];
      for (const r of own) declared.push(rebase(pkg, r));

      let target = `${pkg}/`;
      if (await isDir(path.join(pkgAbs, "src"))) target = `${pkg}/src/`;
      else if (await isDir(path.join(pkgAbs, "contracts"))) target = `${pkg}/contracts/`;
      auto.push({ context: "", prefix: `${name}/`, target });

      deeper.push(await inferLibRemappings(root, pkg, pkgConfig?.libs ?? ["lib"], depth + 1));
    }
  }

  const levels: Remapping[][] = [[...declared, ...auto]];
  for (const nested of deeper) {
    nested.forEach((list, i) => {
      (levels[i + 1] ??= []).push(...list);
    });
  }
  return levels;
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
