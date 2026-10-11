import * as fs from "node:fs/promises";
import * as path from "node:path";
import picomatch from "picomatch";
import type { ProjectArea, ProjectModel } from "../project/projectModel";
import { toPosix } from "../project/remappings";

export interface IndexScope {
  /** Index the project's test directory. */
  readonly includeTests: boolean;
  /** Index the project's script directory. */
  readonly includeScripts: boolean;
  /** Skip test/, tests/, mock/ and mocks/ directories inside library directories. */
  readonly excludeLibTestsAndMocks: boolean;
  /** Extra glob patterns, matched against paths relative to the project root. */
  readonly exclude: readonly string[];
}

export const DEFAULT_SCOPE: IndexScope = {
  includeTests: true,
  includeScripts: true,
  excludeLibTestsAndMocks: true,
  exclude: [],
};

export interface ScannedFile {
  /** Absolute path as reached inside the project (used to compute import paths). */
  readonly path: string;
  /** Resolved real path (used to deduplicate symlinks and copies). */
  readonly realPath: string;
  readonly area: ProjectArea;
}

/** Directories that never contain sources worth indexing. */
const ALWAYS_SKIPPED_DIRS = new Set([".git", "node_modules", "out", "cache", "broadcast", "artifacts", "coverage", ".vscode-test"]);
const LIB_TEST_DIRS = new Set(["test", "tests", "mock", "mocks"]);

/** Builds the predicate deciding if a file is part of the index. Shared by scanning and the file watcher. */
export function createFileFilter(project: ProjectModel, scope: IndexScope): (absPath: string) => boolean {
  const userExclude = scope.exclude.length > 0 ? picomatch([...scope.exclude], { dot: true }) : undefined;
  return (absPath) => {
    if (!absPath.endsWith(".sol") || !project.contains(absPath)) return false;
    const rel = project.sourceUnitName(absPath);
    const segments = rel.split("/");
    if (segments.slice(0, -1).some((s) => ALWAYS_SKIPPED_DIRS.has(s) && !isUnderRemappingTarget(project, rel))) return false;
    const area = project.areaOf(absPath);
    if (area === "test" && !scope.includeTests) return false;
    if (area === "script" && !scope.includeScripts) return false;
    if (area === "lib" && scope.excludeLibTestsAndMocks && hasLibTestDir(project, rel)) return false;
    if (userExclude?.(rel)) return false;
    return true;
  };
}

/** Within a library, any test/mock directory below the library's own root is skipped. */
function hasLibTestDir(project: ProjectModel, rel: string): boolean {
  const lib = project.config.libs.find((l) => rel.startsWith(`${l}/`));
  const inner = lib ? rel.slice(lib.length + 1) : rel;
  return inner.split("/").slice(1, -1).some((s) => LIB_TEST_DIRS.has(s));
}

/** Remapping targets (e.g. node_modules/@openzeppelin/...) are indexed even in otherwise skipped dirs. */
function isUnderRemappingTarget(project: ProjectModel, rel: string): boolean {
  return project.remappings.some((r) => r.target.endsWith("/") && rel.startsWith(r.target));
}

/** Directories to walk: the configured areas, libraries and remapping targets. */
export function scanRoots(project: ProjectModel, scope: IndexScope): string[] {
  if (!project.hasFoundryToml) return ["."];
  const { config } = project;
  const dirs = new Set<string>([config.src, ...config.libs]);
  if (scope.includeTests) dirs.add(config.test);
  if (scope.includeScripts) dirs.add(config.script);
  for (const r of project.remappings) {
    if (!path.isAbsolute(r.target) && !r.target.startsWith("..")) dirs.add(r.target.replace(/\/+$/, "") || ".");
  }
  // Drop directories nested in another listed one.
  const sorted = [...dirs].sort((a, b) => a.length - b.length);
  return sorted.filter((d, i) => !sorted.slice(0, i).some((p) => p === "." || d === p || d.startsWith(`${p}/`)));
}

/** Walks the project and returns the .sol files that belong in the index. */
export async function scanProject(project: ProjectModel, scope: IndexScope): Promise<ScannedFile[]> {
  const include = createFileFilter(project, scope);
  const seenDirs = new Set<string>();
  const seenFiles = new Map<string, ScannedFile>();

  const walk = async (dir: string): Promise<void> => {
    let realDir: string;
    try {
      realDir = await fs.realpath(dir);
    } catch {
      return;
    }
    if (seenDirs.has(realDir)) return; // Symlink cycle or already-walked directory.
    seenDirs.add(realDir);

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = await fs.stat(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (!shouldPrune(project, scope, full, entry.name)) subdirs.push(full);
      } else if (isFile && entry.name.endsWith(".sol") && include(full)) {
        if (seenFiles.has(full)) continue;
        let realPath = full;
        try {
          realPath = await fs.realpath(full);
        } catch {
          // Keep the path as is.
        }
        seenFiles.set(full, { path: full, realPath, area: project.areaOf(full) });
      }
    }
    for (const sub of subdirs) await walk(sub);
  };

  for (const root of scanRoots(project, scope)) await walk(path.join(project.root, root));
  return [...seenFiles.values()];
}

/** Cheap directory pruning; the file filter remains the source of truth. */
function shouldPrune(project: ProjectModel, scope: IndexScope, dir: string, name: string): boolean {
  if (name.startsWith(".") && name !== ".") return true;
  const rel = toPosix(path.relative(project.root, dir));
  if (ALWAYS_SKIPPED_DIRS.has(name)) {
    // Keep walking towards remapping targets such as node_modules/@openzeppelin/contracts/.
    return !project.remappings.some((r) => r.target.startsWith(`${rel}/`) || `${rel}/`.startsWith(r.target));
  }
  if (scope.excludeLibTestsAndMocks && LIB_TEST_DIRS.has(name) && project.areaOf(path.join(dir, "x.sol")) === "lib") {
    return hasLibTestDir(project, `${rel}/x.sol`);
  }
  return false;
}
