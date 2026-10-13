import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { byteToUtf16Converter, compile, enrichMessage, narrowRange, type CompileRequest, type SolcExec } from "../../src/core/compiler/compile";
import { compilerSettingsFromForge, compilerSettingsFromToml, resolveErrorCodes } from "../../src/core/compiler/compilerSettings";
import { chooseSolc, listInstalledSolc, pragmaRanges, svmDirs } from "../../src/core/compiler/solcVersions";
import { loadProject, ProjectModel } from "../../src/core/project/projectModel";

const FIXTURE = path.resolve(__dirname, "../fixtures/foundry-project");

describe("compiler settings", () => {
  it("applies forge defaults and resolves code names", () => {
    const s = compilerSettingsFromToml("[profile.default]\n");
    expect([...s.ignoredErrorCodes].sort()).toEqual(["1878", "2394", "2424", "3860", "5574", "9207"]);
    expect(s.solc).toBeUndefined();
  });

  it("reads solc, evm_version and ignore lists from the active profile", () => {
    const s = compilerSettingsFromToml(
      `[profile.default]\nsolc_version = "0.8.24"\nevm_version = "Cancun"\nignored_error_codes = ["license", 2072, "unknown-name"]\nignored_warnings_from = ["./test/"]\n[profile.ci]\nsolc = "0.8.30"\n`,
      "ci",
    );
    expect(s).toMatchObject({ solc: "0.8.30", evmVersion: "cancun", ignoredWarningsFrom: ["test/"], origin: "foundry.toml" });
    expect([...s.ignoredErrorCodes].sort()).toEqual(["1878", "2072"]);
  });

  it("reads the resolved values from `forge config --json`", async () => {
    const s = await compilerSettingsFromForge("/p", {
      exec: async (_cmd, args) => {
        expect(args).toEqual(["config", "--json"]);
        return JSON.stringify({ solc: null, evm_version: "osaka", ignored_error_codes: ["license", "func-mutability"], ignored_warnings_from: [] });
      },
    });
    expect(s).toMatchObject({ evmVersion: "osaka", origin: "forge config" });
    expect([...s.ignoredErrorCodes].sort()).toEqual(["1878", "2018"]);
  });

  it("accepts numbers and names", () => {
    expect([...resolveErrorCodes(["shadowing", "5740", 9302])].sort()).toEqual(["2519", "5740", "9302"]);
  });
});

describe("solc versions", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-svm-"));
    for (const v of ["0.8.20", "0.8.30", "0.7.6", "not-a-version"]) {
      await fs.mkdir(path.join(dir, v), { recursive: true });
      if (v !== "0.8.30") await fs.writeFile(path.join(dir, v, `solc-${v}`), "");
    }
    await fs.writeFile(path.join(dir, "0.8.30", "partial"), ""); // incomplete install
  });
  afterAll(() => fs.rm(dir, { recursive: true, force: true }));

  it("finds svm folders per platform", () => {
    expect(svmDirs({ HOME: "/h" }, "darwin")).toEqual(["/h/Library/Application Support/svm", "/h/.svm"]);
    expect(svmDirs({ HOME: "/h" }, "linux")).toEqual(["/h/.local/share/svm", "/h/.svm"]);
    expect(svmDirs({ HOME: "/h", XDG_DATA_HOME: "/x", SVM_HOME: "/s" }, "linux")).toEqual(["/s", "/x/svm", "/h/.svm"]);
  });

  it("lists complete installs, newest first", async () => {
    expect((await listInstalledSolc([dir, path.join(dir, "missing")])).map((s) => s.version)).toEqual(["0.8.20", "0.7.6"]);
  });

  it("reads pragmas, ignoring comments", () => {
    expect(pragmaRanges("// pragma solidity 0.4.0;\npragma solidity ^0.8.20;\npragma solidity >=0.8.0  <0.9.0;\npragma abicoder v2;")).toEqual([
      "^0.8.20",
      ">=0.8.0 <0.9.0",
    ]);
  });

  it("chooses the newest version satisfying every pragma, or the configured one", () => {
    const installed = [
      { version: "0.8.30", path: "/s/0.8.30" },
      { version: "0.8.24", path: "/s/0.8.24" },
      { version: "0.7.6", path: "/s/0.7.6" },
    ];
    expect(chooseSolc(installed, ["^0.8.20"], undefined)).toMatchObject({ kind: "found", solc: { version: "0.8.30" } });
    expect(chooseSolc(installed, ["^0.8.20", "<0.8.25"], undefined)).toMatchObject({ kind: "found", solc: { version: "0.8.24" } });
    expect(chooseSolc(installed, ["^0.6.0"], undefined)).toEqual({ kind: "missing", requirement: "^0.6.0" });
    expect(chooseSolc(installed, ["^0.8.20"], "0.8.24")).toMatchObject({ kind: "found", reason: "foundry.toml", solc: { version: "0.8.24" } });
    expect(chooseSolc(installed, [], "0.8.29")).toEqual({ kind: "missing", requirement: "0.8.29" });
    expect(chooseSolc(installed, [], "/opt/solc")).toMatchObject({ kind: "found", solc: { path: "/opt/solc" } });
  });
});

describe("compile (fake solc)", () => {
  let project: ProjectModel;
  beforeAll(async () => {
    project = await loadProject(FIXTURE, { useForge: false });
  });

  const entry = path.join(FIXTURE, "src/Vault.sol");
  const ENTRY_TEXT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
// ñ 🚀 non-ASCII before the error
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
contract Vault is Ownable {}
`;
  const byteOf = (text: string, needle: string) => Buffer.byteLength(text.slice(0, text.indexOf(needle)), "utf8");

  function request(outputs: unknown[], seen: unknown[] = [], extra: Partial<CompileRequest> = {}): CompileRequest {
    const exec: SolcExec = async (_solc, args, cwd, input) => {
      seen.push({ args, cwd, input: JSON.parse(input) });
      return JSON.stringify(outputs.shift());
    };
    return {
      project,
      entry,
      overlays: new Map([[entry, ENTRY_TEXT]]),
      installed: [{ version: "0.8.30", path: "/svm/solc-0.8.30" }],
      exec,
      ...extra,
    };
  }

  it("sends unsaved sources, remappings and an analysis-only selection", async () => {
    const seen: Array<{ args: string[]; cwd: string; input: { sources: Record<string, unknown>; settings: Record<string, unknown> } }> = [];
    const outcome = await compile(request([{ sources: { "src/Vault.sol": {} } }], seen));
    expect(outcome.kind).toBe("compiled");
    expect(seen[0]!.args).toEqual(["--standard-json", "--base-path", FIXTURE, "--allow-paths", FIXTURE]);
    expect(seen[0]!.input.sources).toEqual({ "src/Vault.sol": { content: ENTRY_TEXT } });
    expect(seen[0]!.input.settings["outputSelection"]).toEqual({ "*": { "": [] } });
    expect(seen[0]!.input.settings["remappings"]).toContain("@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/");
  });

  it("converts byte offsets to UTF-16 and filters like forge", async () => {
    const start = byteOf(ENTRY_TEXT, "Ownable {}");
    const ozFile = "lib/openzeppelin-contracts/contracts/access/Ownable.sol";
    const outcome = await compile(
      request([
        {
          sources: { "src/Vault.sol": {}, [ozFile]: {} },
          errors: [
            { severity: "error", errorCode: "3415", type: "TypeError", message: "No arguments passed to the base constructor.", sourceLocation: { file: "src/Vault.sol", start, end: start + 7 } },
            { severity: "warning", errorCode: "1878", type: "Warning", message: "SPDX license identifier not provided.", sourceLocation: { file: "src/Vault.sol", start: -1, end: -1 } },
            { severity: "warning", errorCode: "2072", type: "Warning", message: "Unused local variable.", sourceLocation: { file: ozFile, start: 10, end: 12 } },
            { severity: "error", errorCode: "9999", type: "TypeError", message: "Broken dependency.", sourceLocation: { file: ozFile, start: 0, end: 6 } },
          ],
        },
      ]),
    );
    if (outcome.kind !== "compiled") throw new Error("expected compiled");
    const diags = outcome.result.diagnostics.get(entry)!;
    expect(diags.map((d) => [d.code, ENTRY_TEXT.slice(d.start, d.end)])).toEqual([
      ["3415", "Ownable"],
      ["9999", `import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";`],
    ]);
    expect(diags[1]!.message).toBe(`${ozFile}:1:1: Broken dependency.`);
    // Library files never get diagnostics of their own.
    expect([...outcome.result.diagnostics.keys()]).toEqual([entry]);
  });

  it("hides ignored codes and warnings from ignored paths, but never errors", async () => {
    const custom = new ProjectModel(project.root, project.config, project.remappings, "files", true, "", {
      ...project.compiler,
      ignoredErrorCodes: new Set(["2072", "3415"]),
      ignoredWarningsFrom: ["src/"],
    });
    const at = byteOf(ENTRY_TEXT, "Vault");
    const outcome = await compile({
      ...request([
        {
          sources: { "src/Vault.sol": {} },
          errors: [
            { severity: "warning", errorCode: "2072", type: "Warning", message: "a", sourceLocation: { file: "src/Vault.sol", start: at, end: at + 1 } },
            { severity: "warning", errorCode: "5667", type: "Warning", message: "b", sourceLocation: { file: "src/Vault.sol", start: at, end: at + 1 } },
            { severity: "error", errorCode: "3415", type: "TypeError", message: "c", sourceLocation: { file: "src/Vault.sol", start: at, end: at + 1 } },
          ],
        },
      ]),
      project: custom,
      extraIgnoredCodes: new Set(["5667"]),
    });
    if (outcome.kind !== "compiled") throw new Error("expected compiled");
    expect(outcome.result.diagnostics.get(entry)!.map((d) => d.code)).toEqual(["3415"]);
  });

  it("retries without evmVersion when solc does not know it", async () => {
    const custom = new ProjectModel(project.root, project.config, project.remappings, "files", true, "", { ...project.compiler, evmVersion: "osaka" });
    const seen: Array<{ input: { settings: Record<string, unknown> } }> = [];
    await compile({
      ...request([{ errors: [{ severity: "error", type: "JSONError", message: "Invalid EVM version requested." }] }, { sources: {} }], seen),
      project: custom,
    });
    expect(seen.map((s) => s.input.settings["evmVersion"])).toEqual(["osaka", undefined]);
  });

  it("retries with another version when an import requires it (5333)", async () => {
    const seen: Array<{ args: readonly string[] }> = [];
    const runs: string[] = [];
    const exec: SolcExec = async (solc, args, _cwd, input) => {
      runs.push(solc);
      seen.push({ args });
      void input;
      return JSON.stringify(
        runs.length === 1
          ? { errors: [{ severity: "error", errorCode: "5333", type: "SyntaxError", message: "Source file requires different compiler version", sourceLocation: { file: "lib/forge-std/src/Test.sol", start: 0, end: 10 } }] }
          : { sources: { "src/Vault.sol": {} } },
      );
    };
    // lib/forge-std/src/Test.sol has `pragma solidity >=0.6.2 <0.9.0`; pretend the newest is outside it.
    const outcome = await compile({
      ...request([]),
      exec,
      installed: [
        { version: "0.9.1", path: "/svm/0.9.1" },
        { version: "0.8.30", path: "/svm/0.8.30" },
      ],
      overlays: new Map([[entry, "pragma solidity >=0.8.20;\ncontract Vault {}\n"]]),
    });
    expect(runs).toEqual(["/svm/0.9.1", "/svm/0.8.30"]);
    expect(outcome.kind === "compiled" && outcome.result.solc.version).toBe("0.8.30");
  });

  it("reports when no installed solc matches", async () => {
    const outcome = await compile({ ...request([]), installed: [{ version: "0.7.6", path: "/svm/0.7.6" }] });
    expect(outcome).toEqual({ kind: "noSolc", requirement: "^0.8.20" });
  });
});

describe("narrowRange", () => {
  const check = (text: string, needle: string) => {
    const start = text.indexOf(needle);
    const [s, e] = narrowRange(text, start, start + needle.length);
    return text.slice(s, e);
  };
  it("reduces declarations to their header and multi-line ranges to the first line", () => {
    const src = "contract Vault is Ownable {\n  uint x;\n}\nfoo(\n  1)";
    expect(check(src, src.slice(0, src.indexOf("}") + 1))).toBe("contract Vault is Ownable");
    expect(check(src, "foo(\n  1)")).toBe("foo(");
    expect(check("uint a = b;", "b")).toBe("b");
  });
});

describe("messages", () => {
  it("suggests the keyword for misspelled identifiers", () => {
    expect(enrichMessage("7920", "Identifier not found or not unique.", "retruns")).toBe("Identifier not found or not unique. Did you mean `returns`?");
    expect(enrichMessage("7576", "Undeclared identifier.", "memroy")).toBe("Undeclared identifier. Did you mean `memory`?");
    expect(enrichMessage("7576", "Undeclared identifier.", "Ownable")).toBe("Undeclared identifier.");
    expect(enrichMessage("3415", "x", "retruns")).toBe("x");
  });

  it("converts UTF-8 byte offsets", () => {
    const text = "a ñ 🚀 b";
    const conv = byteToUtf16Converter(text);
    expect(text.slice(conv(Buffer.byteLength("a ñ 🚀 ", "utf8")))).toBe("b");
  });
});

// --- Real solc -------------------------------------------------------------------

const installed = await listInstalledSolc(svmDirs());
const real = installed.find((s) => s.version.startsWith("0.8."));

describe.skipIf(!real)("compile (real solc)", () => {
  it("reports semantic errors of unsaved code at the right place", async () => {
    const project = await loadProject(FIXTURE, { useForge: false });
    const entry = path.join(FIXTURE, "src/Vault.sol");
    const text = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
// ñ 🚀 non-ASCII before the errors
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
contract Vault is Ownable {
    function f() public pure retruns (uint256) { return Missing; }
}
`;
    const outcome = await compile({ project, entry, overlays: new Map([[entry, text]]), installed: [real!] });
    if (outcome.kind !== "compiled") throw new Error(`no solc: ${outcome.requirement}`);
    const diags = outcome.result.diagnostics.get(entry)!;
    const summary = diags.map((d) => [d.code, text.slice(d.start, d.end), d.message]);
    expect(summary).toContainEqual(["7920", "retruns", "Identifier not found or not unique. Did you mean `returns`?"]);
  });

  it("finds the missing base constructor arguments", async () => {
    const project = await loadProject(FIXTURE, { useForge: false });
    const entry = path.join(FIXTURE, "src/Vault.sol");
    const text = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
// ñ 🚀
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
contract Vault is Ownable {
    uint256 public x = Missing;
}
`;
    const outcome = await compile({ project, entry, overlays: new Map([[entry, text]]), installed: [real!] });
    if (outcome.kind !== "compiled") throw new Error("no solc");
    const diags = outcome.result.diagnostics.get(entry)!.map((d) => [d.code, text.slice(d.start, d.end)]);
    expect(diags).toContainEqual(["7576", "Missing"]);
    const fixed = text.replace("uint256 public x = Missing;", "");
    const again = await compile({ project, entry, overlays: new Map([[entry, fixed]]), installed: [real!] });
    if (again.kind !== "compiled") throw new Error("no solc");
    const ctor = again.result.diagnostics.get(entry)!;
    expect(ctor.map((d) => [d.code, fixed.slice(d.start, d.end)])).toEqual([["3415", "contract Vault is Ownable"]]);
  });
});
