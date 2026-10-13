import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { parseStructure, type SourceStructure } from "../core/completion/structure";
import { structureFile, type StructureFile, type StructureHost } from "../core/completion/symbols";
import type { ProjectHandle } from "./workbenchCore";

const MAX_CACHED_FILES = 500;

/**
 * Tolerant structures (see `parseStructure`) of open documents, once per version, and of
 * files on disk, once per modification. Parsing is synchronous but linear and fast (a few
 * milliseconds for the largest OpenZeppelin files), so it runs on demand.
 */
export class StructureService implements vscode.Disposable {
  private readonly documents = new Map<string, { version: number; file: StructureFile }>();
  private readonly files = new Map<string, { stamp: string; file: StructureFile }>();
  private readonly listener = vscode.workspace.onDidCloseTextDocument((doc) => this.documents.delete(doc.uri.toString()));

  /** The structure of an open document at its current version. */
  ofDocument(document: vscode.TextDocument): StructureFile {
    const key = document.uri.toString();
    const hit = this.documents.get(key);
    if (hit && hit.version === document.version) return hit.file;
    const text = document.getText();
    const file = structureFile(document.uri.fsPath, text, parseStructure(text));
    this.documents.set(key, { version: document.version, file });
    return file;
  }

  structure(document: vscode.TextDocument): SourceStructure {
    return this.ofDocument(document).structure;
  }

  /** A file as currently edited if open, else as saved. */
  async load(filePath: string): Promise<StructureFile | undefined> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === filePath);
    if (open) return this.ofDocument(open);
    let stamp: string;
    try {
      const st = await fs.stat(filePath);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      this.files.delete(filePath);
      return undefined;
    }
    const hit = this.files.get(filePath);
    if (hit && hit.stamp === stamp) return hit.file;
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      return undefined;
    }
    const file = structureFile(filePath, text);
    this.files.set(filePath, { stamp, file });
    if (this.files.size > MAX_CACHED_FILES) this.files.delete(this.files.keys().next().value!);
    return file;
  }

  /** Access to the files of a project (or next to the document, outside any project). */
  host(project: ProjectHandle | undefined): StructureHost {
    return {
      load: (p) => this.load(p),
      resolveImport: (importPath, importer) => (project ? project.model.resolveImport(importPath, importer) : path.resolve(path.dirname(importer), importPath)),
    };
  }

  dispose(): void {
    this.listener.dispose();
    this.documents.clear();
    this.files.clear();
  }
}
