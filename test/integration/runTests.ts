import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  // Compiled to out/integration/runTests.js.
  const repoRoot = path.resolve(__dirname, "../..");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sw-integration-"));
  // Work on a copy so tests can edit files freely.
  const workspace = path.join(tmp, "foundry-project");
  fs.cpSync(path.join(repoRoot, "test/fixtures/foundry-project"), workspace, { recursive: true });

  try {
    await runTests({
      version: process.env["VSCODE_TEST_VERSION"] ?? "stable",
      extensionDevelopmentPath: repoRoot,
      extensionTestsPath: path.join(__dirname, "suite/index"),
      launchArgs: [
        workspace,
        // No other Solidity extension: the workbench must work on its own.
        "--disable-extensions",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        `--user-data-dir=${path.join(tmp, "user-data")}`,
      ],
      extensionTestsEnv: { SW_TEST_WORKSPACE: workspace },
    });
  } catch (err) {
    console.error("Integration tests failed", err);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

void main();
