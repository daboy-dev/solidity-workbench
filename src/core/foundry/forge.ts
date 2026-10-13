import * as path from "node:path";
import { runProcess } from "../process";

/** Runs a command and resolves with stdout; rejects on a non-zero exit. */
export type ExecFn = (command: string, args: readonly string[], cwd: string, input?: string) => Promise<string>;

export type Env = Readonly<Record<string, string | undefined>>;

export const defaultExec: ExecFn = (command, args, cwd, input) =>
  runProcess(command, args, { cwd, ...(input !== undefined ? { input } : {}) });

/**
 * Where to look for forge. foundryup installs it in ~/.foundry/bin and adds
 * that folder to the PATH of interactive shells only, so VS Code (especially
 * when started from the Dock) often does not see it on the PATH.
 */
export function forgeCandidates(forgePath: string | undefined, env: Env = process.env): string[] {
  if (forgePath && forgePath !== "forge") return [forgePath];
  const exe = process.platform === "win32" ? "forge.exe" : "forge";
  const home = env["HOME"] ?? env["USERPROFILE"];
  const dirs = [env["FOUNDRY_DIR"], home && path.join(home, ".foundry")].filter((d): d is string => !!d);
  return [...new Set(["forge", ...dirs.map((d) => path.join(d, "bin", exe))])];
}

export function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

export interface ForgeRun {
  readonly forge: string;
  readonly stdout: string;
}

/**
 * Runs forge with the first candidate that exists. A candidate that runs but
 * fails stops the search (the next one would fail the same way); the error
 * is rethrown.
 */
export async function runForge(
  args: readonly string[],
  cwd: string,
  options: { forgePath?: string; env?: Env; exec?: ExecFn; input?: string } = {},
): Promise<ForgeRun> {
  const exec = options.exec ?? defaultExec;
  let lastError: unknown = new Error("forge not found");
  for (const forge of forgeCandidates(options.forgePath, options.env)) {
    try {
      return { forge, stdout: await exec(forge, args, cwd, options.input) };
    } catch (err) {
      lastError = err;
      if (!isNotFound(err)) break;
    }
  }
  throw lastError;
}

/** First line of forge's error output, without ANSI colours, for messages. */
export function forgeErrorSummary(err: unknown): string {
  const stderr = (err as { stderr?: string })?.stderr ?? "";
  const clean = stderr.replace(/\x1b\[[0-9;]*m/g, "");
  const line = clean.split("\n").map((l) => l.trim()).find((l) => /^error/i.test(l)) ?? clean.split("\n").find((l) => l.trim());
  return (line ?? (err instanceof Error ? err.message : String(err))).trim();
}
