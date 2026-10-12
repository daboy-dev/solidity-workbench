import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import type { FileParser } from "../core/index/fileParser";
import type { DocumentAnalysis } from "../core/solidity/analyzeDocument";

const MAX_CACHED_FILES = 500;

/** An analysis together with the document version it was computed for. */
export interface AnalyzedDocument {
  readonly version: number;
  readonly analysis: DocumentAnalysis;
}

/** A file on disk with its analysis. */
export interface AnalyzedFile {
  readonly text: string;
  readonly analysis: DocumentAnalysis;
}

/**
 * Analyses open documents off the main thread, once per version, sharing the
 * result between features (outline, syntax diagnostics, navigation).
 */
export class DocumentAnalysisService implements vscode.Disposable {
  private readonly cache = new Map<string, { version: number; promise: Promise<AnalyzedDocument> }>();
  private readonly files = new Map<string, { stamp: string; promise: Promise<AnalyzedFile | undefined> }>();
  private readonly listener: vscode.Disposable;

  constructor(private readonly parser: FileParser) {
    this.listener = vscode.workspace.onDidCloseTextDocument((doc) => this.cache.delete(doc.uri.toString()));
  }

  analyze(document: vscode.TextDocument): Promise<AnalyzedDocument> {
    const key = document.uri.toString();
    const hit = this.cache.get(key);
    if (hit && hit.version === document.version) return hit.promise;
    const version = document.version;
    const promise = this.parser.analyzeDocument(document.getText()).then((analysis) => ({ version, analysis }));
    this.cache.set(key, { version, promise });
    // Do not keep failures around: a later request retries.
    promise.catch(() => {
      if (this.cache.get(key)?.promise === promise) this.cache.delete(key);
    });
    return promise;
  }

  /** Analyses a file as saved on disk, once per modification. */
  async analyzeFile(path: string): Promise<AnalyzedFile | undefined> {
    let stamp: string;
    try {
      const st = await fs.stat(path);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      this.files.delete(path);
      return undefined;
    }
    const hit = this.files.get(path);
    if (hit && hit.stamp === stamp) return hit.promise;
    const promise = fs
      .readFile(path, "utf8")
      .then(async (text) => ({ text, analysis: await this.parser.analyzeDocument(text) }))
      .catch(() => undefined);
    this.files.set(path, { stamp, promise });
    if (this.files.size > MAX_CACHED_FILES) this.files.delete(this.files.keys().next().value!);
    return promise;
  }

  dispose(): void {
    this.listener.dispose();
    this.cache.clear();
    this.files.clear();
    this.parser.dispose();
  }
}
