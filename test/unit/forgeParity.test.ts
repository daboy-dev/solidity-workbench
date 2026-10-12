import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseFoundryConfig } from "../../src/core/project/foundryConfig";
import { defaultExec, forgeCandidates, loadRemappings } from "../../src/core/project/remappingSource";
import { formatRemapping } from "../../src/core/project/remappings";

/**
 * Checks that the forge-less fallback infers the same remappings as the real
 * `forge remappings`. Skipped when forge is not installed.
 */
const FIXTURE = path.resolve(__dirname, "../fixtures/foundry-project");

async function findForge(): Promise<string | undefined> {
  for (const candidate of forgeCandidates(undefined)) {
    try {
      await defaultExec(candidate, ["--version"], os.tmpdir());
      return candidate;
    } catch {
      // Try the next location.
    }
  }
  return undefined;
}

const forge = await findForge();

/** Creates files from a { "relative/path": content } map. */
async function layout(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
}

async function compare(root: string): Promise<void> {
  const config = parseFoundryConfig(await fs.readFile(path.join(root, "foundry.toml"), "utf8"));
  const real = await loadRemappings(root, config, { forgePath: forge! });
  const fallback = await loadRemappings(root, config, { useForge: false });
  expect(real.origin).toBe("forge");
  expect(fallback.remappings.map(formatRemapping).sort()).toEqual(real.remappings.map(formatRemapping).sort());
}

describe.skipIf(!forge)("fallback remappings match forge", () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sw-parity-"));
  });
  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("on the fixture project", async () => {
    await compare(FIXTURE);
  });

  it("with nested libraries, declared remappings and libraries without foundry.toml", async () => {
    const root = path.join(tmp, "nested");
    const toml = "[profile.default]\n";
    await layout(root, {
      "foundry.toml": toml,
      "src/A.sol": "contract A {}",
      "lib/a/foundry.toml": toml,
      "lib/a/src/A.sol": "contract A {}",
      "lib/a/lib/uniq/src/U.sol": "contract U {}",
      "lib/a/lib/b/foundry.toml": '[profile.default]\nremappings = ["@b/=src/"]\n',
      "lib/a/lib/b/src/B.sol": "contract B {}",
      "lib/a/lib/c/src/C.sol": "contract C {}",
      "lib/c/contracts/C.sol": "contract C {}",
      "lib/plain/remappings.txt": "@plain/=src/\n",
      "lib/plain/src/P.sol": "contract P {}",
      "lib/flat/F.sol": "contract F {}",
      "lib/wrapper/W.sol": "contract W {}",
      "lib/wrapper/lib/inner/src/I.sol": "contract I {}",
    });
    await compare(root);
  });

  it("when the project redefines a library prefix", async () => {
    const root = path.join(tmp, "override");
    await layout(root, {
      "foundry.toml": "[profile.default]\n",
      "remappings.txt": "dep/=lib/dep/contracts/\n",
      "lib/dep/src/D.sol": "contract D {}",
      "lib/dep/contracts/D.sol": "contract D {}",
      "lib/x/lib/dep/src/D.sol": "contract D {}",
    });
    await compare(root);
  });
});
