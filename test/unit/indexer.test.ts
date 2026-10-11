import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InlineFileParser, WorkerFileParser } from "../../src/core/index/fileParser";
import { ProjectIndexer } from "../../src/core/index/projectIndexer";
import { DEFAULT_SCOPE, scanProject, scanRoots } from "../../src/core/index/scanner";
import { loadProject } from "../../src/core/project/projectModel";

const FIXTURE = path.resolve(__dirname, "../fixtures/foundry-project");

let tmp: string;
let root: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sw-index-"));
  root = path.join(tmp, "project");
  await fs.cp(FIXTURE, root, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const rel = (p: string) => path.relative(root, p).split(path.sep).join("/");

describe("scanProject", () => {
  it("walks src, test, script and lib, skipping lib tests and mocks", async () => {
    const project = await loadProject(root, { useForge: false });
    const files = (await scanProject(project, DEFAULT_SCOPE)).map((f) => rel(f.path)).sort();
    expect(files).toContain("src/Vault.sol");
    expect(files).toContain("test/mocks/MockToken.sol");
    expect(files).toContain("script/Deploy.s.sol");
    expect(files).toContain("lib/openzeppelin-contracts/contracts/access/Ownable.sol");
    expect(files).toContain("lib/solmate-lite/lib/openzeppelin-contracts/contracts/access/Ownable.sol");
    expect(files).not.toContain("lib/openzeppelin-contracts/contracts/mocks/OwnableMock.sol");
    expect(files).not.toContain("lib/openzeppelin-contracts/test/OwnableTestHelper.sol");
  });

  it("honours scope settings and exclude globs", async () => {
    const project = await loadProject(root, { useForge: false });
    const files = (
      await scanProject(project, {
        includeTests: false,
        includeScripts: false,
        excludeLibTestsAndMocks: false,
        exclude: ["lib/solmate-lite/**"],
      })
    ).map((f) => rel(f.path));
    expect(files).not.toContain("test/Vault.t.sol");
    expect(files).not.toContain("script/Deploy.s.sol");
    expect(files).toContain("lib/openzeppelin-contracts/contracts/mocks/OwnableMock.sol");
    expect(files.some((f) => f.startsWith("lib/solmate-lite/"))).toBe(false);
  });

  it("collapses nested roots", async () => {
    const project = await loadProject(root, { useForge: false });
    expect(scanRoots(project, DEFAULT_SCOPE).sort()).toEqual(["lib", "script", "src", "test"]);
  });

  it("deduplicates symlinked files by real path", async () => {
    await fs.symlink(path.join(root, "lib/openzeppelin-contracts"), path.join(root, "lib/oz-link"), "dir");
    const project = await loadProject(root, { useForge: false });
    const files = await scanProject(project, DEFAULT_SCOPE);
    const ownables = files.filter((f) => f.path.endsWith(path.join("access", "Ownable.sol")));
    const real = new Set(ownables.map((f) => f.realPath));
    // The symlinked copy is walked once (same real directory); the nested copy is a different file.
    expect(real.size).toBe(2);
  });
});

describe("ProjectIndexer", () => {
  it("indexes every symbol kind across the project", async () => {
    const project = await loadProject(root, { useForge: false });
    const indexer = new ProjectIndexer(project, DEFAULT_SCOPE, { parser: new InlineFileParser() });
    const stats = await indexer.build();
    expect(stats.parsed).toBe(stats.files);
    const kinds = Object.fromEntries(
      ["Ownable", "Context", "IERC20", "Test", "Position", "Side", "InsufficientBalance", "Deposited", "Shares", "MAX_BPS", "toShares"].map(
        (n) => [n, indexer.index.lookup(n).map((s) => s.kind)],
      ),
    );
    expect(kinds).toEqual({
      Ownable: ["abstract", "abstract"],
      Context: ["abstract"],
      IERC20: ["interface"],
      Test: ["abstract"],
      Position: ["struct"],
      Side: ["enum"],
      InsufficientBalance: ["error"],
      Deposited: ["event"],
      Shares: ["type"],
      MAX_BPS: ["constant"],
      toShares: ["function"],
    });
  });

  it("reuses the disk cache when mtimes are unchanged and reparses changed files", async () => {
    const cacheFile = path.join(tmp, "cache", "index.json");
    const project = await loadProject(root, { useForge: false });
    const first = new ProjectIndexer(project, DEFAULT_SCOPE, { parser: new InlineFileParser(), cacheFile });
    await first.build();
    await first.flushCache();

    const vault = path.join(root, "src/Vault.sol");
    await fs.writeFile(vault, "pragma solidity ^0.8.20;\ncontract Vault {}\ncontract VaultV2 {}\n");
    const future = new Date(Date.now() + 5_000);
    await fs.utimes(vault, future, future);

    const second = new ProjectIndexer(project, DEFAULT_SCOPE, { parser: new InlineFileParser(), cacheFile });
    const stats = await second.build();
    expect(stats.parsed).toBe(1);
    expect(stats.fromCache).toBe(stats.files - 1);
    expect(second.index.lookup("VaultV2")).toHaveLength(1);
    await second.flushCache();
  });

  it("updates incrementally on create, change and delete", async () => {
    const project = await loadProject(root, { useForge: false });
    const indexer = new ProjectIndexer(project, DEFAULT_SCOPE, { parser: new InlineFileParser() });
    await indexer.build();

    const created = path.join(root, "src/NewThing.sol");
    await fs.writeFile(created, "contract NewThing {}\n");
    await indexer.updateFiles([created]);
    expect(indexer.index.lookup("NewThing")).toHaveLength(1);

    await fs.writeFile(created, "contract Renamed {}\n// longer content\n");
    await indexer.updateFiles([created]);
    expect(indexer.index.lookup("NewThing")).toHaveLength(0);
    expect(indexer.index.lookup("Renamed")).toHaveLength(1);

    indexer.removePath(path.join(root, "lib/openzeppelin-contracts"));
    expect(indexer.index.lookup("IERC20")).toHaveLength(0);
    expect(indexer.index.lookup("Ownable")).toHaveLength(1);

    // Files outside the scope are ignored.
    const mock = path.join(root, "lib/solmate-lite/test/Mock.sol");
    await fs.mkdir(path.dirname(mock), { recursive: true });
    await fs.writeFile(mock, "contract LibMock {}\n");
    await indexer.updateFiles([mock]);
    expect(indexer.index.lookup("LibMock")).toHaveLength(0);
  });

  it("falls back to inline parsing when the worker cannot start", async () => {
    const errors: string[] = [];
    const parser = new WorkerFileParser(path.join(tmp, "missing-worker.js"), (m) => errors.push(m));
    const [result] = await parser.parse([path.join(root, "src/Types.sol")]);
    parser.dispose();
    expect(result!.symbols.map((s) => s.name)).toContain("Position");
    expect(errors.length).toBeGreaterThan(0);
  });
});
