import * as fs from "node:fs/promises";
import * as path from "node:path";
import semver from "semver";
import type { Env } from "../foundry/forge";
import { blankTrivia } from "../solidity/lexContext";

export interface InstalledSolc {
  readonly version: string;
  readonly path: string;
}

/**
 * Folders where svm (used by forge) installs solc binaries, as
 * `<dir>/<version>/solc-<version>`: the platform data dir, and the legacy ~/.svm.
 */
export function svmDirs(env: Env = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const home = env["HOME"] ?? env["USERPROFILE"] ?? "";
  const dirs: string[] = [];
  if (env["SVM_HOME"]) dirs.push(env["SVM_HOME"]);
  if (platform === "darwin") dirs.push(path.join(home, "Library", "Application Support", "svm"));
  else if (platform === "win32") dirs.push(path.join(env["APPDATA"] ?? path.join(home, "AppData", "Roaming"), "svm"));
  else dirs.push(path.join(env["XDG_DATA_HOME"] ?? path.join(home, ".local", "share"), "svm"));
  dirs.push(path.join(home, ".svm"));
  return [...new Set(dirs)];
}

/** Installed solc binaries, newest first. */
export async function listInstalledSolc(dirs: readonly string[], platform: NodeJS.Platform = process.platform): Promise<InstalledSolc[]> {
  const found = new Map<string, InstalledSolc>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const version of entries) {
      if (!semver.valid(version) || found.has(version)) continue;
      const binary = path.join(dir, version, `solc-${version}${platform === "win32" ? ".exe" : ""}`);
      try {
        if ((await fs.stat(binary)).isFile()) found.set(version, { version, path: binary });
      } catch {
        // Incomplete install.
      }
    }
  }
  return [...found.values()].sort((a, b) => semver.rcompare(a.version, b.version));
}

/** Version ranges of every `pragma solidity` in the file (all must hold). */
export function pragmaRanges(text: string): string[] {
  const out: string[] = [];
  for (const m of blankTrivia(text).matchAll(/\bpragma\s+solidity\s+([^;]+);/g)) {
    const range = m[1]!.trim().replace(/\s+/g, " ");
    if (semver.validRange(range)) out.push(range);
  }
  return out;
}

export type SolcChoice =
  | { readonly kind: "found"; readonly solc: InstalledSolc; readonly reason: string }
  | { readonly kind: "missing"; readonly requirement: string };

/**
 * Picks the solc to analyse with, like forge would:
 * - a `solc` path from the configuration or the setting is used as is;
 * - a `solc` version from the configuration must be installed;
 * - otherwise the newest installed version that satisfies every range.
 */
export function chooseSolc(installed: readonly InstalledSolc[], ranges: readonly string[], configured: string | undefined): SolcChoice {
  if (configured) {
    if (/[\\/]/.test(configured)) {
      return { kind: "found", solc: { version: "custom", path: configured }, reason: "configured path" };
    }
    const version = semver.valid(semver.coerce(configured));
    const match = version ? installed.find((s) => s.version === version) : undefined;
    return match ? { kind: "found", solc: match, reason: "foundry.toml" } : { kind: "missing", requirement: configured };
  }
  const match = installed.find((s) => ranges.every((r) => semver.satisfies(s.version, r)));
  if (match) return { kind: "found", solc: match, reason: ranges.length ? `pragma ${ranges.join(" and ")}` : "newest installed" };
  return { kind: "missing", requirement: ranges.length ? ranges.join(" and ") : "any version" };
}
