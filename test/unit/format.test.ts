import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultExec, forgeCandidates } from "../../src/core/foundry/forge";
import { formatWithForge } from "../../src/core/foundry/format";

describe("formatWithForge", () => {
  it("passes the text on stdin and returns stdout", async () => {
    const calls: Array<{ cmd: string; args: readonly string[]; cwd: string; input?: string }> = [];
    const result = await formatWithForge("contract A{}", "/proj", {
      exec: async (cmd, args, cwd, input) => {
        calls.push({ cmd, args, cwd, ...(input !== undefined ? { input } : {}) });
        return "contract A {}\n";
      },
    });
    expect(result).toEqual({ ok: true, text: "contract A {}\n" });
    expect(calls).toEqual([{ cmd: "forge", args: ["fmt", "--raw", "-"], cwd: "/proj", input: "contract A{}" }]);
  });

  it("discards the output when forge fails, even if it printed code", async () => {
    // forge fmt prints partially formatted code AND exits with 1 on syntax errors.
    const result = await formatWithForge("contract A {", "/proj", {
      exec: async () => {
        throw Object.assign(new Error("Command failed"), {
          code: 1,
          stdout: "contract A {}\n",
          stderr: "\u001b[31mError\u001b[0m: solar reported errors:\n\nerror: expected contract item, found `<eof>`\n",
        });
      },
    });
    expect(result).toEqual({ ok: false, error: "Error: solar reported errors:" });
  });
});

const forge = await (async () => {
  for (const c of forgeCandidates(undefined)) {
    try {
      await defaultExec(c, ["--version"], os.tmpdir());
      return c;
    } catch {
      // next
    }
  }
  return undefined;
})();

describe.skipIf(!forge)("formatWithForge with the real forge", () => {
  it("applies the project's [fmt] settings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sw-fmt-"));
    try {
      await fs.writeFile(path.join(root, "foundry.toml"), "[profile.default]\n[fmt]\ntab_width = 2\n");
      const result = await formatWithForge("contract A{function f() public{uint a=1;}}\n", root, { forgePath: forge! });
      expect(result).toEqual({ ok: true, text: "contract A {\n  function f() public {\n    uint256 a = 1;\n  }\n}\n" });
      expect((await formatWithForge("contract A {\n", root, { forgePath: forge! })).ok).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
