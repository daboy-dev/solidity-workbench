import { forgeErrorSummary, runForge, type Env, type ExecFn } from "./forge";

export type FormatResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string };

/**
 * Formats Solidity source with `forge fmt`, reading from stdin so unsaved
 * changes are formatted and the `[fmt]` section of the project's foundry.toml
 * (found from `root`) applies.
 *
 * On a syntax error forge exits with 1 but still prints partially formatted
 * code: that output is discarded, only a clean exit is trusted.
 */
export async function formatWithForge(
  text: string,
  root: string,
  options: { forgePath?: string; env?: Env; exec?: ExecFn } = {},
): Promise<FormatResult> {
  try {
    const { stdout } = await runForge(["fmt", "--raw", "-"], root, { ...options, input: text });
    return { ok: true, text: stdout };
  } catch (err) {
    return { ok: false, error: forgeErrorSummary(err) };
  }
}
