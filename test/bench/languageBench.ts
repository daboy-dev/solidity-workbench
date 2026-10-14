// Benchmark of the language features on a large Foundry project, with the real forge and solc.
// Usage: npx esbuild test/bench/languageBench.ts --bundle --platform=node --outfile=<out.cjs> && node <out.cjs> <projectRoot>
// (uses forge from PATH or ~/.foundry/bin and solc installed by forge)
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compile } from "../../src/core/compiler/compile";
import { complete, namesInScope } from "../../src/core/completion/complete";
import { cursorContext } from "../../src/core/completion/cursorContext";
import { parseStructure } from "../../src/core/completion/structure";
import { structureFile, type StructureFile, type StructureHost } from "../../src/core/completion/symbols";
import { listInstalledSolc, svmDirs } from "../../src/core/compiler/solcVersions";
import { findDefinitions, sourceFile, type SourceFile, type SourceHost } from "../../src/core/navigation/definitions";
import { loadProject } from "../../src/core/project/projectModel";
import { analyzeDocument } from "../../src/core/solidity/analyzeDocument";
import { runProcess } from "../../src/core/process";
import { compileProjectAst, listOwnFiles } from "../../src/core/references/projectAst";
import { prepareProjectRename, renameInProject } from "../../src/core/references/projectRename";
import { findReferences } from "../../src/core/references/references";

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

  // Completion: tolerant structure of large files, then requests through OpenZeppelin's inheritance.
  await settle();
  for (const rel of ["lib/openzeppelin-contracts/contracts/governance/Governor.sol", "lib/forge-std/src/safeconsole.sol"]) {
    const text = await fs.readFile(path.join(root, rel), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) runs.push((await time(() => parseStructure(text)))[1]);
    console.log(`parseStructure ${path.basename(rel)} (${text.split("\n").length} lines): ${stats(runs)}; max lag ${lagSince()}`);
  }
  const structures = new Map<string, StructureFile>();
  const structureHost: StructureHost = {
    async load(p) {
      let f = structures.get(p);
      if (!f) {
        const text = await fs.readFile(p, "utf8").catch(() => undefined);
        if (text === undefined) return undefined;
        f = structureFile(p, text);
        structures.set(p, f);
      }
      return f;
    },
    resolveImport: (imp, importer) => project.resolveImport(imp, importer),
  };
  // The parses above run back to back without yielding: let the ticker record them before measuring requests.
  await settle();
  const probes: Array<[string, string]> = [
    ["IERC20(asset()).safeTransfer", "IERC20(asset()).|"],
    ["uint256 capped = Math.min(amount, totalAssets());", "uint256 capped = |"],
    ["_grantRole(DEFAULT_ADMIN_ROLE, _msgSender());", "_grantRole(DEFAULT_ADMIN_ROLE, |);"],
    ["return super.supportsInterface(id);", "return super.|"],
    ["uint256 capped = Math.min(amount, totalAssets());", "Math.|"],
    ["uint256 capped = Math.min(amount, totalAssets());", "uint256 capped = add|"],
  ];
  for (const [find, replace] of probes) {
    const text = ENTRY_TEXT.replace(find, replace);
    const offset = text.indexOf("|");
    const clean = text.slice(0, offset) + text.slice(offset + 1);
    const env = { version: "0.8.30", path: ENTRY, host: structureHost };
    const coldCache = structures.size;
    const [list, tCold] = await time(() => complete(cursorContext(parseStructure(clean), offset), env));
    const warm: number[] = [];
    for (let i = 0; i < 5; i++) warm.push((await time(() => complete(cursorContext(parseStructure(clean), offset), env)))[1]);
    const first = [...list].sort((a, b) => a.rank - b.rank).slice(0, 5).map((e) => e.label).join(", ");
    console.log(`complete ${replace.padEnd(36)} ${String(list.length).padStart(3)} items (${first}); first ${tCold.toFixed(1)} ms (${structures.size - coldCache} files parsed), then ${stats(warm)}; max lag ${lagSince()}`);
  }
  {
    const text = ENTRY_TEXT.replace("uint256 capped = Math.min(amount, totalAssets());", "uint256 capped = Mat|");
    const offset = text.indexOf("|");
    const clean = text.slice(0, offset) + text.slice(offset + 1);
    const runs: number[] = [];
    let size = 0;
    for (let i = 0; i < 5; i++) {
      const [names, t] = await time(() => namesInScope(cursorContext(parseStructure(clean), offset), { version: "0.8.30", path: ENTRY, host: structureHost }));
      runs.push(t);
      size = names.size;
    }
    console.log(`namesInScope (auto-import dedup, ${size} names): ${stats(runs)}`);
  }
  console.log(`  (completion runs on the extension host thread) max lag ${lagSince()}`);

  // ---- rename / references with solc's AST -------------------------------------------
  // A member used in many files: BenchCore.deposit and Position.size, from GEN_FILES test files.
  const GEN_FILES = Number(process.env["SW_BENCH_FILES"] ?? 60);
  const genDir = path.join(root, "test/bench-gen");
  const core = path.join(root, "src/BenchCore.sol");
  await fs.writeFile(
    core,
    `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.24;\nstruct Position {\n    uint256 size;\n}\ncontract BenchCore {\n    mapping(address => Position) public positions;\n    function deposit(uint256 amount) external { positions[msg.sender].size += amount; }\n}\n`,
  );
  await fs.mkdir(genDir, { recursive: true });
  for (let i = 0; i < GEN_FILES; i++) {
    await fs.writeFile(
      path.join(genDir, `Use${i}.t.sol`),
      `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.24;\nimport {BenchCore, Position} from "../../src/BenchCore.sol";\nimport {BenchVault} from "../../src/BenchVault.sol";\ncontract Use${i} {\n    BenchCore internal core;\n    BenchVault internal vault;\n    function run(Position memory p) external {\n        core.deposit(p.size);\n        core.deposit(p.size + ${i});\n        core.deposit(vault.totalAssets());\n    }\n}\n`,
    );
  }
  try {
    const own = await listOwnFiles(project);
    const sources = new Map<string, string>();
    for (const f of own) sources.set(f, await fs.readFile(f, "utf8"));
    const installed = await listInstalledSolc(svmDirs());
    let solcMs = 0;
    let astBytes = 0;
    const exec = async (solc: string, args: readonly string[], cwd: string, input: string, signal?: AbortSignal) => {
      const t0 = performance.now();
      const out = await runProcess(solc, args, { cwd, input, timeoutMs: 120_000, ...(signal ? { signal } : {}) });
      solcMs += performance.now() - t0;
      astBytes += out.length;
      return out;
    };
    await settle();
    const [ast, tAst] = await time(() => compileProjectAst({ project, sources, installed, exec }));
    const occurrences = [...ast.index.occurrences.values()].reduce((n, l) => n + l.length, 0);
    console.log(
      `project AST: ${own.length} own files, ${ast.groups.length} group(s) (${ast.groups.map((g) => g.solc ?? g.requirement).join(", ")}), ${(astBytes / 1e6).toFixed(1)} MB of JSON, ${ast.index.decls.size} declarations, ${occurrences} occurrences`,
    );
    console.log(`  ${tAst.toFixed(0)} ms in total: solc ${solcMs.toFixed(0)} ms, JSON.parse + index ${(tAst - solcMs).toFixed(0)} ms (in the extension this runs in the worker); lag here ${lagSince()}`);
    await settle();
    const [, tClone] = await time(() => structuredClone(ast));
    console.log(`  index copied from the worker (structured clone): ${tClone.toFixed(0)} ms; lag ${lagSince()}`);

    const coreText = sources.get(core)!;
    const depositAt = coreText.indexOf("deposit");
    await settle();
    const [refs, tRefs] = await time(() => findReferences(ast.index, core, depositAt, coreText));
    console.log(`findReferences(deposit): ${refs.length} occurrences in ${new Set(refs.map((r) => r.file)).size} files, ${tRefs.toFixed(1)} ms; lag ${lagSince()}`);

    for (const [label, offset] of [["deposit", depositAt], ["Position.size", coreText.indexOf("size")]] as const) {
      const prepared = prepareProjectRename(ast, project, sources, core, offset);
      if (!prepared.ok) throw new Error(prepared.reason);
      solcMs = 0;
      const [result, tRename] = await time(() =>
        renameInProject({ project, ast, sources, target: prepared.target, newName: `${prepared.placeholder}2`, compile: (s) => compileProjectAst({ project, sources: s, installed, exec }), exists: () => false }),
      );
      if (!result.ok) throw new Error(result.reason);
      const edits = [...result.rename.plan.edits.values()].reduce((n, l) => n + l.length, 0);
      console.log(`rename ${label}: ${edits} edits in ${result.rename.plan.edits.size} files, ${tRename.toFixed(0)} ms (checking compile: solc ${solcMs.toFixed(0)} ms)`);
    }
  } finally {
    await fs.rm(genDir, { recursive: true, force: true });
    await fs.rm(core, { force: true });
  }
  clearInterval(ticker);
  await fs.rm(ENTRY);
}

void main();
