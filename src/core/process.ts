import { execFile } from "node:child_process";

export interface RunOptions {
  readonly cwd: string;
  /** Written to stdin once the process has started. */
  readonly input?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Runs a command and resolves with stdout; rejects on failure, with `stderr` attached to the error. */
export function runProcess(command: string, args: readonly string[], options: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: 64 * 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout: String(stdout), stderr: String(stderr) }));
        else resolve(stdout);
      },
    );
    // Write only once the process exists: writing to a command that failed to start (ENOENT)
    // raises SIGPIPE in the host. An early exit can still close the pipe; the exit code is what
    // gets reported, so the stdin error itself is ignored.
    child.stdin?.on("error", () => {});
    if (options.input !== undefined) child.once("spawn", () => child.stdin?.end(options.input));
    else child.stdin?.end();
  });
}

export function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && ((err as { name?: string }).name === "AbortError" || (err as { code?: string }).code === "ABORT_ERR");
}
