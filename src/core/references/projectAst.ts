import * as fs from "node:fs";
import * as path from "node:path";
import { runStandardJson, type SolcExec, type SolcOutput } from "../compiler/compile";
import { chooseSolc, pragmaRanges, type InstalledSolc } from "../compiler/solcVersions";
import type { ProjectModel } from "../project/projectModel";
import { computeLineStarts, lineOf } from "../solidity/extractSymbols";
import { analyzeFile } from "../solidity/fileAnalysis";
import { byteToUtf16Converter } from "../compiler/compile";
import { indexAst, mergeIndexes, emptyIndex, type ReferenceIndex } from "./astIndex";

/**
 * Compiles every own file of a project (src, test, script) with solc to get its
 * AST, like `forge build` does: files are grouped by the solc version their
 * imports allow, and each group is compiled separately.
 */

export interface ProjectAstRequest {
  readonly project: ProjectModel;
  /** Every own file of the project with its current text (unsaved buffers included). */
  readonly sources: ReadonlyMap<string, string>;
  readonly installed: readonly InstalledSolc[];
  /** A solc version or path that overrides the pragmas (configuration or setting). */
  readonly configured?: string;
  readonly signal?: AbortSignal;
  readonly exec?: SolcExec;
}

export interface CompileError {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface CompileGroup {
  /** The solc used, or the version requirement when none is installed. */
  readonly solc?: string;
  readonly requirement?: string;
  /** Own files compiled in this group. */
  readonly files: readonly string[];
  /** Every file solc read (own and library). */
  readonly closure: readonly string[];
  /** Every error found, including those of excluded files. */
  readonly errors: readonly CompileError[];
  /** Own files left out because they (or a file they import) do not compile, with what they import. */
  readonly excluded: ReadonlyArray<{ readonly file: string; readonly closure: readonly string[]; readonly error: CompileError }>;
  /** True when no AST could be produced (errors outside the own files, or too many rounds). */
  readonly failed: boolean;
}

export interface ProjectAst {
  readonly index: ReferenceIndex;
  readonly groups: readonly CompileGroup[];
  readonly durationMs: number;
}

export async function compileProjectAst(req: ProjectAstRequest): Promise<ProjectAst> {
  const started = Date.now();
  const { project } = req;
  const texts = new Map(req.sources);
  const textOf = (abs: string): string => {
    let t = texts.get(abs);
    if (t === undefined) {
      try {
        t = fs.readFileSync(abs, "utf8");
      } catch {
        t = "";
      }
      texts.set(abs, t);
    }
    return t;
  };

  const plan = planGroups(project, [...req.sources.keys()], textOf, req.installed, req.configured);
  const results = await Promise.all(plan.map((g) => compileGroup(req, g, textOf)));
  return { index: mergeIndexes(results.map((r) => r.index)), groups: results.map((r) => r.group), durationMs: Date.now() - started };
}

const MAX_ROUNDS = 16;

/**
 * Compiles a group. solc gives no AST when anything fails, so files with errors are
 * left out (with every file importing them) and the rest is compiled again: a broken
 * test elsewhere does not prevent renaming. Callers decide whether an excluded file
 * could refer to the symbol at hand.
 */
async function compileGroup(req: ProjectAstRequest, g: PlannedGroup, textOf: (abs: string) => string): Promise<{ group: CompileGroup; index: ReferenceIndex }> {
  const { project } = req;
  if (!g.solc) return { group: { requirement: g.requirement!, files: g.files, closure: g.closure, errors: [], excluded: [], failed: true }, index: emptyIndex() };
  const solc = g.solc.version === "custom" ? g.solc.path : g.solc.version;
  const errors: CompileError[] = [];
  const excluded: Array<{ file: string; closure: readonly string[]; error: CompileError }> = [];
  let own = g.closure.filter((f) => req.sources.has(f));
  for (let round = 0; round < MAX_ROUNDS && own.length; round++) {
    const sources: Record<string, { content: string }> = {};
    for (const f of own) sources[project.sourceUnitName(f)] = { content: req.sources.get(f)! };
    const output: SolcOutput = await runStandardJson({
      project,
      solc: g.solc,
      sources,
      outputSelection: { "*": { "": ["ast"] } },
      ...(req.signal ? { signal: req.signal } : {}),
      ...(req.exec ? { exec: req.exec } : {}),
    });
    const found = (output.errors ?? []).filter((e) => e.severity === "error").map((e) => toError(project, e, textOf));
    const compiled = Object.keys(output.sources ?? {}).map((n) => project.absolutePath(n));
    errors.push(...found);
    if (!found.length) {
      const index = indexAst((output.sources ?? {}) as Parameters<typeof indexAst>[0], { project, textOf });
      return { group: { solc, files: g.files, closure: compiled, errors, excluded, failed: false }, index };
    }
    const broken = new Map<string, CompileError>();
    for (const e of found) if (e.file && req.sources.has(e.file) && !broken.has(e.file)) broken.set(e.file, e);
    // An error in a library, or one solc cannot place: nothing can be left out.
    if (!broken.size || found.some((e) => !e.file || !req.sources.has(e.file))) break;
    const keep: string[] = [];
    for (const f of own) {
      const closure = g.closures.get(f) ?? [f];
      const cause = closure.find((c) => broken.has(c));
      if (cause) excluded.push({ file: f, closure, error: broken.get(cause)! });
      else keep.push(f);
    }
    own = keep;
  }
  return { group: { solc, files: g.files, closure: g.closure, errors, excluded, failed: own.length > 0 || !excluded.length }, index: emptyIndex() };
}

function toError(project: ProjectModel, e: NonNullable<SolcOutput["errors"]>[number], textOf: (abs: string) => string): CompileError {
  const loc = e.sourceLocation;
  if (!loc?.file || loc.start < 0) return { file: "", line: 0, column: 0, message: e.message };
  const file = project.absolutePath(loc.file);
  const text = textOf(file);
  const offset = byteToUtf16Converter(text)(loc.start);
  const starts = computeLineStarts(text);
  const line = lineOf(starts, offset);
  return { file, line: line + 1, column: offset - starts[line]! + 1, message: e.message };
}

interface PlannedGroup {
  readonly solc?: InstalledSolc;
  readonly requirement?: string;
  readonly files: string[];
  readonly closure: string[];
  /** What each own file of the closure imports, transitively (itself included). */
  readonly closures: ReadonlyMap<string, readonly string[]>;
}

/** Groups own files by the solc that can compile them with everything they import. */
export function planGroups(
  project: ProjectModel,
  files: readonly string[],
  textOf: (abs: string) => string,
  installed: readonly InstalledSolc[],
  configured: string | undefined,
): PlannedGroup[] {
  const imports = new Map<string, string[]>();
  const importsOf = (f: string) => {
    let list = imports.get(f);
    if (!list) {
      list = analyzeFile(textOf(f)).imports.map((i) => project.resolveImport(i.path, f));
      imports.set(f, list);
    }
    return list;
  };
  const closureOf = (f: string): string[] => {
    const seen = new Set([f]);
    const queue = [f];
    while (queue.length) for (const g of importsOf(queue.pop()!)) if (!seen.has(g)) (seen.add(g), queue.push(g));
    return [...seen];
  };
  const pragmas = new Map<string, string[]>();
  const pragmasOf = (f: string) => {
    let p = pragmas.get(f);
    if (!p) pragmas.set(f, (p = pragmaRanges(textOf(f))));
    return p;
  };

  const closures = new Map<string, string[]>();
  const groups = new Map<string, { solc?: InstalledSolc; requirement?: string; files: string[]; closure: Set<string> }>();
  for (const f of files) {
    const closure = closureOf(f);
    closures.set(f, closure);
    const choice = chooseSolc(installed, configured ? [] : [...new Set(closure.flatMap(pragmasOf))], configured);
    const id = choice.kind === "found" ? choice.solc.path : `missing:${choice.requirement}`;
    let g = groups.get(id);
    if (!g) {
      g = choice.kind === "found" ? { solc: choice.solc, files: [], closure: new Set() } : { requirement: choice.requirement, files: [], closure: new Set() };
      groups.set(id, g);
    }
    g.files.push(f);
    for (const c of closure) g.closure.add(c);
  }
  return [...groups.values()].map((g) => ({ ...(g.solc ? { solc: g.solc } : { requirement: g.requirement! }), files: g.files, closure: [...g.closure], closures }));
}

const SKIPPED_DIRS = new Set([".git", "node_modules", "out", "cache", "broadcast", "artifacts", "coverage"]);

/** The project's own Solidity files: src, test and script (everything outside lib/ without a foundry.toml). */
export async function listOwnFiles(project: ProjectModel): Promise<string[]> {
  const { config } = project;
  const roots = project.hasFoundryToml ? [...new Set([config.src, config.test, config.script])] : ["."];
  const out = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name) && project.areaOf(abs) !== "lib") await walk(abs);
      } else if (e.isFile() && e.name.endsWith(".sol") && project.areaOf(abs) !== "lib") out.add(abs);
    }
  };
  for (const r of roots) await walk(path.join(project.root, r));
  return [...out].sort();
}
