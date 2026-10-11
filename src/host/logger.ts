import * as vscode from "vscode";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
  show(): void;
}

export function createLogger(): Logger & vscode.Disposable {
  const channel = vscode.window.createOutputChannel("Solidity Workbench", { log: true });
  return {
    info: (m) => channel.info(m),
    warn: (m) => channel.warn(m),
    error: (m, err) => channel.error(err instanceof Error ? `${m}: ${err.stack ?? err.message}` : err !== undefined ? `${m}: ${String(err)}` : m),
    show: () => channel.show(true),
    dispose: () => channel.dispose(),
  };
}
