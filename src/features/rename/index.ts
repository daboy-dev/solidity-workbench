import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { declKey } from "../../core/references/astIndex";
import { localSymbolAt, renameLocal, type TextEdit } from "../../core/references/locals";
import { prepareProjectRename, renameInProject } from "../../core/references/projectRename";
import type { ProjectAst } from "../../core/references/projectAst";
import type { SourceSnapshot } from "../../host/references";
import { positionConverter } from "../../host/sourceHost";
import type { ProjectHandle, WorkbenchCore } from "../../host/workbenchCore";
import { SOLIDITY_TEXT_SELECTOR, type Feature } from "../feature";

/** Rename Symbol (F2): locals with the tolerant parser, everything else with solc's AST. */
export const renameFeature: Feature = {
  id: "rename",
  activate(core: WorkbenchCore): vscode.Disposable {
    return vscode.languages.registerRenameProvider(SOLIDITY_TEXT_SELECTOR, new SolidityRenameProvider(core));
  },
};

const IDENTIFIER = /[A-Za-z_$][\w$]*/;

class SolidityRenameProvider implements vscode.RenameProvider {
  constructor(private readonly core: WorkbenchCore) {}

  async prepareRename(document: vscode.TextDocument, position: vscode.Position): Promise<{ range: vscode.Range; placeholder: string }> {
    const offset = document.offsetAt(position);
    const local = localSymbolAt(this.core.structures.structure(document), offset);
    if (local) {
      const range = local.occurrences.find((o) => o.start <= offset && offset <= o.end) ?? local.declaration;
      return { range: new vscode.Range(document.positionAt(range.start), document.positionAt(range.end)), placeholder: local.decl.name };
    }
    if (!document.getWordRangeAtPosition(position, IDENTIFIER)) throw new Error("There is no symbol here that can be renamed.");
    const { project, ast, snapshot } = await this.projectAst(document);
    const prepared = prepareProjectRename(ast, project.model, snapshot.sources, document.uri.fsPath, offset);
    if (!prepared.ok) throw new Error(prepared.reason);
    const { start, end } = prepared.target;
    return { range: new vscode.Range(document.positionAt(start), document.positionAt(end)), placeholder: prepared.placeholder };
  }

  async provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, rawName: string, token: vscode.CancellationToken): Promise<vscode.WorkspaceEdit | undefined> {
    const newName = rawName.trim();
    const offset = document.offsetAt(position);
    const structure = this.core.structures.structure(document);
    const local = localSymbolAt(structure, offset);
    if (local) {
      const result = renameLocal(structure, local, newName);
      if (!result.ok) throw new Error(result.reason);
      const edit = new vscode.WorkspaceEdit();
      const label = { label: `Rename \`${local.decl.name}\` to \`${newName}\``, needsConfirmation: false };
      for (const e of result.edits) edit.replace(document.uri, toRange(document, e), e.newText, label);
      if (local.decl.kind === "parameter" || local.decl.kind === "return") await this.addNamedArguments(edit, document, declKey(document.uri.fsPath, local.decl.nameStart), local.decl.name, newName);
      return edit;
    }

    const { project, ast, snapshot } = await this.projectAst(document);
    if (token.isCancellationRequested) return undefined;
    const prepared = prepareProjectRename(ast, project.model, snapshot.sources, document.uri.fsPath, offset);
    if (!prepared.ok) throw new Error(prepared.reason);
    const result = await this.withProgress("checking the rename with solc", () =>
      renameInProject({
        project: project.model,
        ast,
        sources: snapshot.sources,
        target: prepared.target,
        newName,
        compile: (sources) => this.core.references.compile(project, sources),
        exists: (p) => fs.existsSync(p),
      }),
    );
    if (!result.ok) throw new Error(result.reason);
    if (token.isCancellationRequested) return undefined;

    const { plan, importEdits } = result.rename;
    const edit = new vscode.WorkspaceEdit();
    const symbolLabel = { label: `Rename \`${plan.oldName}\` to \`${newName}\``, needsConfirmation: false };
    const hierarchyLabel = { label: `Overrides and implementations of \`${plan.oldName}\``, needsConfirmation: false };
    // The file is moved first; its edits then go to the new path (VS Code applies file operations before text edits).
    const moved = (file: string) => vscode.Uri.file(plan.file && file === plan.file.from ? plan.file.to : file);
    if (plan.file) {
      edit.renameFile(vscode.Uri.file(plan.file.from), vscode.Uri.file(plan.file.to), { overwrite: false }, {
        label: `Rename ${path.basename(plan.file.from)} to ${path.basename(plan.file.to)}`,
        needsConfirmation: false,
      });
    }
    for (const [file, edits] of plan.edits) {
      const toPos = this.converter(file, snapshot);
      for (const e of edits) edit.replace(moved(file), new vscode.Range(toPos(e.start), toPos(e.end)), e.newText, e.group === "symbol" ? symbolLabel : hierarchyLabel);
    }
    if (plan.file) {
      const importLabel = { label: `Import paths of ${path.basename(plan.file.from)}`, needsConfirmation: false };
      for (const [file, edits] of importEdits) {
        const toPos = this.converter(file, snapshot);
        for (const e of edits) edit.replace(moved(file), new vscode.Range(toPos(e.start), toPos(e.end)), e.newText, importLabel);
      }
    }
    return edit;
  }

  /** `f({name: ...})` calls of a renamed parameter, when the project compiles (best effort). */
  private async addNamedArguments(edit: vscode.WorkspaceEdit, document: vscode.TextDocument, key: string, oldName: string, newName: string): Promise<void> {
    if (document.uri.scheme !== "file") return;
    try {
      const { ast, snapshot } = await this.projectAst(document);
      const label = { label: `Named arguments \`${oldName}:\``, needsConfirmation: false };
      for (const [file, list] of ast.index.occurrences) {
        const named = list.filter((o) => o.key === key && o.kind === "namedArgument");
        if (!named.length) continue;
        const toPos = this.converter(file, snapshot);
        for (const o of named) edit.replace(vscode.Uri.file(file), new vscode.Range(toPos(o.start), toPos(o.end)), newName, label);
      }
    } catch (err) {
      this.core.log.info(`Named arguments not updated: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async projectAst(document: vscode.TextDocument): Promise<{ project: ProjectHandle; ast: ProjectAst; snapshot: SourceSnapshot }> {
    const project = document.uri.scheme === "file" ? await this.core.projectFor(document.uri) : undefined;
    if (!project) throw new Error("Renaming this symbol needs the file to be part of a Foundry project.");
    const { ast, snapshot } = await this.withProgress("analysing the project with solc", () => this.core.references.ast(project));
    this.core.log.info(`solc AST of ${path.basename(project.model.root)}: ${ast.groups.map((g) => g.solc ?? `missing ${g.requirement}`).join(", ")} in ${ast.durationMs} ms`);
    return { project, ast, snapshot };
  }

  private converter(file: string, snapshot: SourceSnapshot): (offset: number) => vscode.Position {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === file);
    return open ? (o) => open.positionAt(o) : positionConverter(snapshot.sources.get(file) ?? "");
  }

  private withProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
    return Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `$(sync~spin) Solidity Workbench: ${title}…` }, task));
  }
}

function toRange(document: vscode.TextDocument, e: TextEdit): vscode.Range {
  return new vscode.Range(document.positionAt(e.start), document.positionAt(e.end));
}
