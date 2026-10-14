import * as path from "node:path";
import type { ProjectModel } from "../project/projectModel";
import { computeLineStarts, lineOf } from "../solidity/extractSymbols";
import { applyEdits, type TextEdit } from "./locals";
import type { ProjectAst } from "./projectAst";
import { compileProblem, importPathEdits, planRename, renameTarget, verifyRename, type RenamePlan, type Target } from "./rename";

/** Rename across the project's own files with solc's AST: prepare, plan, then check by recompiling. */

export type Prepared = { readonly ok: true; readonly target: Target; readonly placeholder: string } | { readonly ok: false; readonly reason: string };

export function relativeTo(project: ProjectModel): (abs: string) => string {
  return (abs) => path.relative(project.root, abs) || abs;
}

/** What can be renamed at `offset` of `file`, or why nothing can. */
export function prepareProjectRename(ast: ProjectAst, project: ProjectModel, sources: ReadonlyMap<string, string>, file: string, offset: number): Prepared {
  const rel = relativeTo(project);
  if (project.areaOf(file) === "lib") return { ok: false, reason: "Library code (lib/) is never renamed." };
  const problem = compileProblem(ast.groups, file, rel);
  if (problem) return { ok: false, reason: problem };
  const text = sources.get(file) ?? "";
  const target = renameTarget(ast.index, file, offset, text);
  if (!target) return { ok: false, reason: "There is no symbol here that can be renamed." };
  if (target.kind === "decl") {
    const declProblem = compileProblem(ast.groups, target.decl.file, rel);
    if (declProblem && !target.decl.inLib) return { ok: false, reason: declProblem };
    if (target.decl.inLib) return { ok: false, reason: `\`${target.decl.name}\` is declared in ${rel(target.decl.file)}; library code is never renamed.` };
  }
  return { ok: true, target, placeholder: target.kind === "alias" ? target.local : target.decl.name };
}

export interface ProjectRenameRequest {
  readonly project: ProjectModel;
  readonly ast: ProjectAst;
  /** The texts `ast` was built from: every own file. */
  readonly sources: ReadonlyMap<string, string>;
  readonly target: Target;
  readonly newName: string;
  /** Compiles modified sources (to check the rename). */
  readonly compile: (sources: ReadonlyMap<string, string>) => Promise<ProjectAst>;
  readonly exists: (abs: string) => boolean;
}

export interface ProjectRename {
  readonly plan: RenamePlan;
  /** Import paths to update when the contract's file is renamed. */
  readonly importEdits: Map<string, TextEdit[]>;
}

export type ProjectRenameResult = { readonly ok: true; readonly rename: ProjectRename } | { readonly ok: false; readonly reason: string };

export async function renameInProject(req: ProjectRenameRequest): Promise<ProjectRenameResult> {
  const { project, sources } = req;
  const rel = relativeTo(project);
  const textOf = (abs: string) => sources.get(abs) ?? "";
  const planned = planRename({ index: req.ast.index, textOf, rel, exists: req.exists }, req.target, req.newName);
  if (!planned.ok) return planned;
  const { plan } = planned;

  const renamed = new Map(sources);
  for (const [file, edits] of plan.edits) renamed.set(file, applyEdits(textOf(file), edits));
  const after = await req.compile(renamed);
  const lines = new Map<string, number[]>();
  const lineAt = (abs: string, offset: number) => {
    let starts = lines.get(abs);
    if (!starts) lines.set(abs, (starts = computeLineStarts(renamed.get(abs) ?? "")));
    return lineOf(starts, offset) + 1;
  };
  const known = new Set(req.ast.groups.flatMap((g) => g.errors.map((e) => `${e.file}:${e.message}`)));
  for (const g of after.groups) {
    const e = g.errors.find((x) => !known.has(`${x.file}:${x.message}`));
    if (e) return { ok: false, reason: `Renaming to \`${req.newName}\` would not compile: ${e.file ? `${rel(e.file)}:${e.line}:${e.column}: ` : ""}${e.message}` };
  }
  const broken = verifyRename(req.ast.index, after.index, plan.edits, rel, lineAt);
  if (broken) return { ok: false, reason: broken };

  const importEdits = plan.file ? importPathEdits(sources, (p, importer) => project.resolveImport(p, importer), plan.file.from, plan.file.to) : new Map<string, TextEdit[]>();
  return { ok: true, rename: { plan, importEdits } };
}
