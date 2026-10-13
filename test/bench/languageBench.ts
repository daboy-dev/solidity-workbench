// Benchmark of the language features on a large Foundry project, with the real forge and solc.
// Usage: npx esbuild test/bench/languageBench.ts --bundle --platform=node --outfile=<out.cjs> && node <out.cjs> <projectRoot>
// (uses forge from PATH or ~/.foundry/bin and solc installed by forge)
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compile } from "../../src/core/compiler/compile";
import { listInstalledSolc, svmDirs } from "../../src/core/compiler/solcVersions";
import { findDefinitions, sourceFile, type SourceFile, type SourceHost } from "../../src/core/navigation/definitions";
import { loadProject } from "../../src/core/project/projectModel";
import { analyzeDocument } from "../../src/core/solidity/analyzeDocument";

async function main(): Promise<void> {
  const root = process.argv[2]!;
  const ENTRY = path.join(root, "src/BenchVault.sol");
  const ENTRY_TEXT = `// SPDX-License-Identifier: MIT
  pragma solidity ^0.8.24;

  import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
  import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
  import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
  import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
  import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
  import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
  import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

  contract BenchVault is ERC4626, AccessControl {
      using SafeERC20 for IERC20;
      bytes32 public constant KEEPER = keccak256("KEEPER");

      constructor(IERC20 asset_) ERC4626(asset_) ERC20("Vault", "V") {
          _grantRole(DEFAULT_ADMIN_ROLE, _msgSender());
      }

      function harvest(uint256 amount) external onlyRole(KEEPER) {
          uint256 capped = Math.min(amount, totalAssets());
          IERC20(asset()).safeTransfer(_msgSender(), capped);
      }

      function supportsInterface(bytes4 id) public view override(AccessControl) returns (bool) {
          return super.supportsInterface(id);
      }
  }
  `;

  let lag = 0;
  let last = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now();
    lag = Math.max(lag, now - last - 5);
    last = now;
  }, 5);

  const stats = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return `median ${s[Math.floor(s.length / 2)]!.toFixed(0)} ms, max ${s.at(-1)!.toFixed(0)} ms (n=${s.length})`;
  };
  const time = async <T>(f: () => Promise<T> | T): Promise<[T, number]> => {
    const t0 = performance.now();
    const r = await f();
    return [r, performance.now() - t0];
  };

  await fs.mkdir(path.dirname(ENTRY), { recursive: true });
  await fs.writeFile(ENTRY, ENTRY_TEXT);

  /** Max event-loop lag since the last call: shows what would block the extension host. */
  const lagSince = () => {
    const value = lag;
    lag = 0;
    return `${value.toFixed(0)} ms`;
  };
  /** Lets the ticker record any delay caused by the previous section before measuring the next one. */
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 50));
    lag = 0;
  };

  const [project, tProject] = await time(() => loadProject(root));
  console.log(`loadProject: ${tProject.toFixed(0)} ms (${project.remappings.length} remappings via ${project.remappingOrigin}, compiler settings via ${project.compiler.origin}); max lag ${lagSince()}`);

  // Syntax analysis + outline of large files.
  for (const rel of ["src/BenchVault.sol", "lib/openzeppelin-contracts/contracts/governance/Governor.sol", "lib/openzeppelin-contracts/contracts/utils/math/Math.sol"]) {
    const text = await fs.readFile(path.join(root, rel), "utf8");
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) runs.push((await time(() => analyzeDocument(text)))[1]);
    console.log(`analyzeDocument ${path.basename(rel)} (${text.split("\n").length} lines): ${stats(runs)}`);
  }
  console.log(`  (synchronous on purpose: in the extension it runs in a worker thread) max lag ${lagSince()}`);

  // Compiler diagnostics.
  await settle();
  const installed = await listInstalledSolc(svmDirs());
  const overlays = new Map([[ENTRY, ENTRY_TEXT]]);
  const runs: number[] = [];
  let solcInfo = "";
  for (let i = 0; i < 10; i++) {
    const [outcome, t] = await time(() => compile({ project, entry: ENTRY, overlays, installed }));
    runs.push(t);
    if (outcome.kind === "compiled") solcInfo = `${outcome.result.solc.version}, ${outcome.result.diagnostics.get(ENTRY)!.length} diagnostics on the entry`;
    else solcInfo = `no solc for ${outcome.requirement}`;
  }
  console.log(`compile BenchVault (OZ ERC4626 + AccessControl + Governor): ${stats(runs)}; first ${runs[0]!.toFixed(0)} ms; ${solcInfo}; max lag ${lagSince()}`);

  await settle();
  // Typing burst: a check starts every 5 ms (faster than solc) and each one cancels the previous.
  {
    let completed = 0;
    let aborted = 0;
    const t0 = performance.now();
    let previous: AbortController | undefined;
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 15; i++) {
      previous?.abort();
      const controller = new AbortController();
      previous = controller;
      const text = ENTRY_TEXT.replace("KEEPER\")", `KEEPER${i}")`);
      pending.push(
        compile({ project, entry: ENTRY, overlays: new Map([[ENTRY, text]]), installed, signal: controller.signal }).then(
          () => void completed++,
          () => void aborted++,
        ),
      );
      await new Promise((r) => setTimeout(r, 5));
    }
    await Promise.all(pending);
    console.log(`typing burst (15 edits, 5 ms apart): ${completed} completed, ${aborted} cancelled, done ${(performance.now() - t0).toFixed(0)} ms after the first keystroke; max lag ${lagSince()}`);
  }

  // Go to Definition through OpenZeppelin's inheritance.
  const cache = new Map<string, SourceFile>();
  const host: SourceHost = {
    async load(p) {
      let f = cache.get(p);
      if (!f) {
        const text = p === ENTRY ? ENTRY_TEXT : await fs.readFile(p, "utf8").catch(() => undefined);
        if (text === undefined) return undefined;
        f = sourceFile(p, text, analyzeDocument(text));
        cache.set(p, f);
      }
      return f;
    },
    resolveImport: (imp, importer) => project.resolveImport(imp, importer),
  };
  const entryFile = (await host.load(ENTRY))!;
  await settle();
  for (const needle of ["_msgSender());", "onlyRole(", "_grantRole(", "Math.min", "min(amount", "safeTransfer(", "totalAssets()", "super.supportsInterface"]) {
    const offset = ENTRY_TEXT.indexOf(needle) + (needle.startsWith("super.") ? 7 : needle.startsWith("Math.") ? 6 : 1);
    const [cold, tCold] = await time(() => findDefinitions(host, entryFile, offset));
    const [, tWarm] = await time(() => findDefinitions(host, entryFile, offset));
    const where = cold.map((t) => `${path.basename(t.path)}:${t.text.slice(0, t.nameStart).split("\n").length}`).join(", ") || "(none)";
    console.log(`definition ${needle.padEnd(24)} → ${where.padEnd(32)} cold ${tCold.toFixed(0)} ms, warm ${tWarm.toFixed(1)} ms`);
  }

  console.log(`  (cold runs parse files synchronously here; in the extension parsing runs in a worker) max lag ${lagSince()}`);
  clearInterval(ticker);
  await fs.rm(ENTRY);
}

void main();
