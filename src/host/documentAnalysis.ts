import * as vscode from "vscode";
import type { FileParser } from "../core/index/fileParser";
import type { DocumentAnalysis } from "../core/solidity/analyzeDocument";

/** An analysis together with the document version it was computed for. */
export interface AnalyzedDocument {
  readonly version: number;
  readonly analysis: DocumentAnalysis;
}

/**
 * Analyses open documents off the main thread, once per version, sharing the
 * result between features (outline, syntax diagnostics, navigation).
 */
export class DocumentAnalysisService implements vscode.Disposable {
  private readonly cache = new Map<string, { version: number; promise: Promise<AnalyzedDocument> }>();
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

  dispose(): void {
    this.listener.dispose();
    this.cache.clear();
    this.parser.dispose();
  }
}
