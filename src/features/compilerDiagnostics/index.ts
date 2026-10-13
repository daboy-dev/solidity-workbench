import * as vscode from "vscode";
import { compile, solcLabel, type CompileResult, type CompilerDiagnostic } from "../../core/compiler/compile";
import { resolveErrorCodes } from "../../core/compiler/compilerSettings";
import { dataLocationFix } from "../../core/compiler/quickFixes";
import { isAbortError } from "../../core/process";
import { isFeatureEnabled, SECTION } from "../../host/settings";
import { configuredSolc, installedSolc, invalidateInstalledSolc } from "../../host/solc";
import { positionConverter } from "../../host/sourceHost";
import type { ProjectHandle, WorkbenchCore } from "../../host/workbenchCore";
import { isSolidityDocument, SOLIDITY_TEXT_SELECTOR, type Feature } from "../feature";

/** solc diagnostics while typing, on unsaved content, filtered like `forge build`. */
export const compilerDiagnosticsFeature: Feature = {
  id: "compilerDiagnostics",
  activate: (core) => new CompilerDiagnostics(core),
};

export const COMPILER_SOURCE = "solc";
const UNNECESSARY_CODES = new Set(["2072", "5667", "5740"]);

interface Settings {
  readonly delay: number;
  readonly ignoredCodes: ReadonlySet<string>;
  readonly solcPath: string | undefined;
}

function readSettings(resource?: vscode.Uri): Settings {
  const cfg = vscode.workspace.getConfiguration(SECTION, resource);
  return {
    delay: Math.max(0, cfg.get<number>("compilerDiagnostics.delay", 400)),
    ignoredCodes: resolveErrorCodes(cfg.get<Array<string | number>>("compilerDiagnostics.ignoredCodes", [])),
    solcPath: configuredSolc(resource),
  };
}

class CompilerDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("solidity-workbench-compiler");
  private readonly status = vscode.window.createStatusBarItem("solidityWorkbench.solc", vscode.StatusBarAlignment.Right, 100);
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, AbortController>();
  private readonly lastResult = new Map<string, { label: string; tooltip: string; warning: boolean }>();
  private readonly notifiedMissing = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly core: WorkbenchCore) {
    this.status.name = "Solidity Workbench: solc";
    this.status.command = "solidityWorkbench.showLog";
    this.disposables.push(
      this.collection,
      this.status,
      vscode.languages.registerCodeActionsProvider(SOLIDITY_TEXT_SELECTOR, new DataLocationFixProvider(), {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }),
      vscode.workspace.onDidOpenTextDocument((doc) => this.schedule(doc, 0)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0) this.schedule(e.document, readSettings(e.document.uri).delay);
      }),
      // A saved file can change what other open files see: re-check the visible ones.
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (!isSolidityDocument(doc)) return;
        for (const editor of vscode.window.visibleTextEditors) if (editor.document !== doc) this.schedule(editor.document, readSettings().delay);
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => this.cancel(doc.uri.toString())),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${SECTION}.compiler`) || e.affectsConfiguration(`${SECTION}.compilerDiagnostics`)) {
          invalidateInstalledSolc();
          for (const editor of vscode.window.visibleTextEditors) this.schedule(editor.document, 0);
        }
      }),
    );
    for (const editor of vscode.window.visibleTextEditors) this.schedule(editor.document, 0);
    this.updateStatus();
  }

  private schedule(document: vscode.TextDocument, delay: number): void {
    if (document.uri.scheme !== "file" || !isSolidityDocument(document)) return;
    const key = document.uri.toString();
    const previous = this.timers.get(key);
    if (previous) clearTimeout(previous);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.check(document);
      }, delay),
    );
  }

  private async check(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    this.running.get(key)?.abort();
    const controller = new AbortController();
    this.running.set(key, controller);

    const project = await this.core.projectFor(document.uri);
    // Library sources are not checked: their warnings are not yours, as in `forge build`.
    if (!project || controller.signal.aborted || project.model.areaOf(document.uri.fsPath) === "lib") return;

    const settings = readSettings(document.uri);
    const version = document.version;
    const overlays = this.overlays(project, document);
    this.setStatus(key, { label: "$(sync~spin) solc", tooltip: "Solidity Workbench: checking with solc…", warning: false });
    try {
      const outcome = await compile({
        project: project.model,
        entry: document.uri.fsPath,
        overlays,
        installed: await installedSolc(),
        ...(settings.solcPath ? { solcOverride: settings.solcPath } : {}),
        extraIgnoredCodes: settings.ignoredCodes,
        signal: controller.signal,
      });
      if (controller.signal.aborted || document.isClosed || document.version !== version) return;
      if (outcome.kind === "noSolc") {
        this.collection.delete(document.uri);
        this.setStatus(key, {
          label: `$(warning) solc ${outcome.requirement}`,
          tooltip: `No installed solc matches ${outcome.requirement}. Run \`forge build\` once to install it.`,
          warning: true,
        });
        void this.offerInstall(project, outcome.requirement);
        return;
      }
      await this.publish(document, outcome.result);
      this.setStatus(key, {
        label: solcLabel(outcome.result.solc),
        tooltip: `Solidity Workbench: checked with ${solcLabel(outcome.result.solc)} (${outcome.result.reason}) in ${outcome.result.durationMs} ms`,
        warning: false,
      });
    } catch (err) {
      if (isAbortError(err)) return;
      this.core.log.error(`solc failed for ${document.uri.fsPath}`, err);
      this.setStatus(key, { label: "$(error) solc", tooltip: `solc failed: ${err instanceof Error ? err.message : String(err)}`, warning: true });
    } finally {
      if (this.running.get(key) === controller) this.running.delete(key);
    }
  }

  /** Unsaved buffers of the project, plus the entry's current text. */
  private overlays(project: ProjectHandle, entry: vscode.TextDocument): Map<string, string> {
    const out = new Map<string, string>();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === "file" && doc.isDirty && isSolidityDocument(doc) && project.model.contains(doc.uri.fsPath)) {
        out.set(doc.uri.fsPath, doc.getText());
      }
    }
    out.set(entry.uri.fsPath, entry.getText());
    return out;
  }

  private async publish(entry: vscode.TextDocument, result: CompileResult): Promise<void> {
    const skipParserErrors = await this.syntaxLayerCovers(entry);
    const converters = new Map<string, (offset: number) => vscode.Position>();
    const converterFor = (file: string) => {
      let c = converters.get(file);
      if (!c) {
        c = positionConverter(result.texts.get(file) ?? "");
        converters.set(file, c);
      }
      return c;
    };
    for (const [file, diagnostics] of result.diagnostics) {
      const list = file === entry.uri.fsPath && skipParserErrors ? diagnostics.filter((d) => d.type !== "ParserError") : diagnostics;
      this.collection.set(vscode.Uri.file(file), list.map((d) => toDiagnostic(d, converterFor(file), converterFor)));
    }
  }

  /** solc stops at the first parser error; when our syntax layer already explains it, its message is clearer. */
  private async syntaxLayerCovers(document: vscode.TextDocument): Promise<boolean> {
    if (!isFeatureEnabled("syntaxDiagnostics", document.uri)) return false;
    const { analysis } = await this.core.analyzeDocument(document);
    return analysis.problems.length > 0;
  }

  private async offerInstall(project: ProjectHandle, requirement: string): Promise<void> {
    const key = `${project.model.root}\u0000${requirement}`;
    if (this.notifiedMissing.has(key)) return;
    this.notifiedMissing.add(key);
    const run = "Run forge build";
    const settings = "Settings";
    const choice = await vscode.window.showWarningMessage(
      `Solidity Workbench: no installed solc matches ${requirement}. Running \`forge build\` once installs it.`,
      run,
      settings,
    );
    if (choice === run) {
      const forge = project.model.remappingOrigin === "forge" ? project.model.forgeStatus : "forge";
      const terminal = vscode.window.createTerminal({ name: "forge build", cwd: project.model.root });
      terminal.show();
      terminal.sendText(`"${forge}" build`);
      invalidateInstalledSolc();
    } else if (choice === settings) {
      void vscode.commands.executeCommand("workbench.action.openSettings", `${SECTION}.compiler`);
    }
  }

  private setStatus(key: string, status: { label: string; tooltip: string; warning: boolean }): void {
    this.lastResult.set(key, status);
    this.updateStatus();
  }

  private updateStatus(): void {
    const doc = vscode.window.activeTextEditor?.document;
    const status = doc && isSolidityDocument(doc) ? this.lastResult.get(doc.uri.toString()) : undefined;
    if (!status) {
      this.status.hide();
      return;
    }
    this.status.text = status.label;
    this.status.tooltip = status.tooltip;
    this.status.backgroundColor = status.warning ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    this.status.show();
  }

  private cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.running.get(key)?.abort();
    this.running.delete(key);
    this.lastResult.delete(key);
  }

  dispose(): void {
    for (const key of [...this.timers.keys(), ...this.running.keys()]) this.cancel(key);
    for (const d of this.disposables) d.dispose();
  }
}

function toDiagnostic(d: CompilerDiagnostic, at: (offset: number) => vscode.Position, converterFor: (file: string) => (offset: number) => vscode.Position): vscode.Diagnostic {
  const range = new vscode.Range(at(d.start), at(d.end));
  const severity =
    d.severity === "error" ? vscode.DiagnosticSeverity.Error : d.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
  const diagnostic = new vscode.Diagnostic(range, d.message, severity);
  diagnostic.source = COMPILER_SOURCE;
  if (d.code) diagnostic.code = d.code;
  if (d.related.length) {
    diagnostic.relatedInformation = d.related.map((r) => {
      const pos = converterFor(r.file);
      return new vscode.DiagnosticRelatedInformation(
        new vscode.Location(vscode.Uri.file(r.file), new vscode.Range(pos(r.start), pos(r.end))),
        r.message || "Related location",
      );
    });
  }
  // Unused variables and parameters, and unreachable code, are faded out by the editor.
  if (UNNECESSARY_CODES.has(d.code)) diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];
  return diagnostic;
}

/** "Add `memory`" (and the other allowed locations) for solc's missing data location error 6651. */
class DataLocationFixProvider implements vscode.CodeActionProvider {
  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== COMPILER_SOURCE || diagnostic.code !== "6651") continue;
      const fix = dataLocationFix(document.getText(), document.offsetAt(diagnostic.range.start), document.offsetAt(diagnostic.range.end), diagnostic.message);
      if (!fix) continue;
      fix.locations.forEach((location, i) => {
        const action = new vscode.CodeAction(`Add \`${location}\``, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = i === 0;
        action.edit = new vscode.WorkspaceEdit();
        action.edit.insert(document.uri, document.positionAt(fix.offset), ` ${location}`);
        actions.push(action);
      });
    }
    return actions;
  }
}
