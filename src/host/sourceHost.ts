import * as path from "node:path";
import * as vscode from "vscode";
import { sourceFile, type SourceFile, type SourceHost } from "../core/navigation/definitions";
import { computeLineStarts, lineOf } from "../core/solidity/extractSymbols";
import type { ProjectHandle, WorkbenchCore } from "./workbenchCore";

/** Navigation access to files: open buffers (possibly unsaved) win over the disk. */
export function createSourceHost(core: WorkbenchCore, project: ProjectHandle | undefined): SourceHost {
  return {
    async load(filePath) {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === filePath);
      if (open) return documentSource(core, open);
      const analyzed = await core.analyzeFile(filePath);
      return analyzed ? sourceFile(filePath, analyzed.text, analyzed.analysis) : undefined;
    },
    resolveImport(importPath, importer) {
      if (project) return project.model.resolveImport(importPath, importer);
      return path.resolve(path.dirname(importer), importPath);
    },
  };
}

/** The SourceFile of an open document, consistent with its current version. */
export async function documentSource(core: WorkbenchCore, document: vscode.TextDocument): Promise<SourceFile | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = document.getText();
    const analyzed = await core.analyzeDocument(document);
    if (analyzed.version === document.version) return sourceFile(document.uri.fsPath, text, analyzed.analysis);
  }
  return undefined;
}

/** Converts an offset of `text` (not necessarily an open document) to a position. */
export function positionIn(text: string, offset: number): vscode.Position {
  return positionConverter(text)(offset);
}

/** Offset-to-position conversion for many offsets of the same text. */
export function positionConverter(text: string): (offset: number) => vscode.Position {
  const starts = computeLineStarts(text);
  return (offset) => {
    const line = lineOf(starts, offset);
    return new vscode.Position(line, offset - starts[line]!);
  };
}
