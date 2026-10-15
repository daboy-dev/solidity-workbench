import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { findImportCandidates, selectForCompletion, subsequenceFilter, type ImportCandidate } from "../../src/core/candidates";
import { InlineFileParser } from "../../src/core/index/fileParser";
import { ProjectIndexer } from "../../src/core/index/projectIndexer";
import { DEFAULT_SCOPE } from "../../src/core/index/scanner";
import { loadProject, type ProjectModel } from "../../src/core/project/projectModel";

const FIXTURE = path.resolve(__dirname, "../fixtures/foundry-project");
const VAULT = path.join(FIXTURE, "src/Vault.sol");

let project: ProjectModel;
let indexer: ProjectIndexer;

beforeAll(async () => {
  project = await loadProject(FIXTURE, { useForge: false });
  indexer = new ProjectIndexer(project, DEFAULT_SCOPE, { parser: new InlineFileParser() });
  await indexer.build();
});

const query = (importer: string, extra: Partial<Parameters<typeof findImportCandidates>[0]> = {}) =>
  findImportCandidates({ project, index: indexer.index, importerPath: importer, pathStyle: "remapped", ...extra });

describe("findImportCandidates", () => {
  it("offers one entry per distinct file, the remapped one first", () => {
    const ownable = query(VAULT, { name: "Ownable" });
    expect(ownable.map((c) => c.importPath)).toEqual([
      "@openzeppelin/contracts/access/Ownable.sol",
      "../lib/solmate-lite/lib/openzeppelin-contracts/contracts/access/Ownable.sol",
    ]);
    expect(ownable[0]!.viaRemapping).toBe(true);
    expect(ownable[1]!.viaRemapping).toBe(false);
  });

  it("uses relative paths for project files and when requested", () => {
    expect(query(VAULT, { name: "Position" })[0]!.importPath).toBe("./Types.sol");
    expect(query(VAULT, { name: "Ownable", pathStyle: "relative" })[0]!.importPath).toBe(
      "../lib/openzeppelin-contracts/contracts/access/Ownable.sol",
    );
  });

  it("hides test and script symbols from src, but not from test", () => {
    expect(query(VAULT, { name: "MockToken" })).toHaveLength(0);
    expect(query(VAULT, { name: "DeployScript" })).toHaveLength(0);
    expect(query(path.join(FIXTURE, "test/Vault.t.sol"), { name: "MockToken" })).toHaveLength(1);
  });

  it("skips excluded names, excluded files and the importer itself", () => {
    expect(query(VAULT, { name: "Vault" })).toHaveLength(0);
    expect(query(VAULT, { name: "Ownable", excludeNames: new Set(["Ownable"]) })).toHaveLength(0);
    const types = query(VAULT, { name: "Position" })[0]!;
    expect(query(VAULT, { name: "Position", excludeFiles: new Set([types.file.realPath]) })).toHaveLength(0);
  });

  it("offers errors, events, structs and enums of contracts qualified, importing their container", () => {
    const [c] = query(VAULT, { name: "OwnableUnauthorizedAccount" });
    expect(c).toMatchObject({
      kind: "error",
      container: "Ownable",
      importName: "Ownable",
      insertText: "Ownable.OwnableUnauthorizedAccount",
      importPath: "@openzeppelin/contracts/access/Ownable.sol",
    });
    expect(c!.containerInScope).toBeUndefined();
    // The container already in scope: nothing to import, only to qualify.
    expect(query(VAULT, { name: "OwnableUnauthorizedAccount", excludeNames: new Set(["Ownable"]) })[0]?.containerInScope).toBe(true);
    expect(query(VAULT, { name: "OwnableUnauthorizedAccount", excludeFiles: new Set([c!.file.realPath]) })[0]?.containerInScope).toBe(true);
    // The member itself in scope (inherited): not offered.
    expect(query(VAULT, { name: "OwnableUnauthorizedAccount", excludeNames: new Set(["OwnableUnauthorizedAccount"]) })).toHaveLength(0);
    // Functions and state variables of contracts are not indexed.
    expect(query(VAULT, { name: "_owner" })).toHaveLength(0);
  });

  it("returns candidates sorted by name", () => {
    const names = query(VAULT).map((c) => c.name);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(expect.arrayContaining(["Context", "IERC20", "MAX_BPS", "Owned", "Shares", "toShares", "Test"]));
  });
});

describe("subsequenceFilter", () => {
  it("matches characters in order, ignoring case", () => {
    const f = subsequenceFilter("own");
    expect(f("Ownable")).toBe(true);
    expect(f("Ownable2Step")).toBe(true);
    expect(f("TransferOwnership")).toBe(true);
    expect(f("Context")).toBe(false);
  });
});

describe("selectForCompletion", () => {
  const c = (name: string): ImportCandidate => ({ name, rank: 0, importPath: name }) as unknown as ImportCandidate;

  it("keeps prefix matches when truncating", () => {
    const all = [c("AOwnB"), c("Ownable"), c("XoXwXn"), c("own")].sort((a, b) => (a.name < b.name ? -1 : 1));
    expect(selectForCompletion(all, "Own", 2).map((x) => x.name)).toEqual(["Ownable", "own"]);
  });
});
