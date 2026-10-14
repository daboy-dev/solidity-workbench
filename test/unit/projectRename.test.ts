import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { listInstalledSolc, svmDirs, type InstalledSolc } from "../../src/core/compiler/solcVersions";
import { loadProject, type ProjectModel } from "../../src/core/project/projectModel";
import { applyEdits } from "../../src/core/references/locals";
import { compileProjectAst, type ProjectAst } from "../../src/core/references/projectAst";
import { prepareProjectRename, renameInProject } from "../../src/core/references/projectRename";
import { findReferences } from "../../src/core/references/references";

/**
 * Renames with the real solc on temporary Foundry projects. Skipped when no solc
 * is installed. Files mark the cursor with `|`.
 */

const installed: InstalledSolc[] = await listInstalledSolc(svmDirs());
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

const has = (v: string) => installed.some((s) => s.version === v);

interface Fixture {
  readonly project: ProjectModel;
  readonly sources: Map<string, string>;
  readonly cursor: { file: string; offset: number };
}

async function fixture(files: Record<string, string>, toml = ""): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sw-rename-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "foundry.toml"), `[profile.default]\nsrc = "src"\nlibs = ["lib"]\n${toml}`);
  const sources = new Map<string, string>();
  let cursor: Fixture["cursor"] | undefined;
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    const at = content.indexOf("|");
    const text = content.replace("|", "");
    if (at >= 0) cursor = { file: abs, offset: at };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    if (!rel.startsWith("lib/")) sources.set(abs, text);
  }
  if (!cursor) throw new Error("no | marker");
  const project = await loadProject(root, { useForge: false });
  return { project, sources, cursor };
}

const compileWith = (project: ProjectModel) => (sources: ReadonlyMap<string, string>) => compileProjectAst({ project, sources, installed });

/** Renames at the cursor; returns the changed files (relative path → text) or the refusal. */
async function rename(files: Record<string, string>, newName: string, toml = ""): Promise<Record<string, string> | string> {
  const { project, sources, cursor } = await fixture(files, toml);
  const ast: ProjectAst = await compileWith(project)(sources);
  const prepared = prepareProjectRename(ast, project, sources, cursor.file, cursor.offset);
  if (!prepared.ok) return `refused: ${prepared.reason}`;
  const result = await renameInProject({ project, ast, sources, target: prepared.target, newName, compile: compileWith(project), exists: fs.existsSync });
  if (!result.ok) return `refused: ${result.reason}`;
  const out: Record<string, string> = {};
  const rel = (abs: string) => path.relative(project.root, abs);
  const all = new Map<string, Array<{ start: number; end: number; newText: string }>>();
  for (const [f, e] of result.rename.plan.edits) all.set(f, [...e]);
  for (const [f, e] of result.rename.importEdits) all.set(f, [...(all.get(f) ?? []), ...e]);
  for (const [f, e] of all) out[rel(f)] = applyEdits(sources.get(f)!, e);
  if (result.rename.plan.file) out["(file)"] = `${rel(result.rename.plan.file.from)} -> ${rel(result.rename.plan.file.to)}`;
  return out;
}

const P = "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n";

describe.skipIf(!has("0.8.37"))("project rename with solc", () => {
  it("renames a state variable, its getter calls and NatSpec-free uses across files", async () => {
    const out = await rename(
      {
        "src/Vault.sol": `${P}contract Vault {\n    uint256 public |total;\n    function add(uint256 v) external { total += v; }\n}\n`,
        "test/Vault.t.sol": `${P}import {Vault} from "../src/Vault.sol";\ncontract VaultTest {\n    function t(Vault v) external view returns (uint256) { return v.total(); }\n}\n`,
      },
      "balance",
    );
    expect(out).toEqual({
      "src/Vault.sol": `${P}contract Vault {\n    uint256 public balance;\n    function add(uint256 v) external { balance += v; }\n}\n`,
      "test/Vault.t.sol": `${P}import {Vault} from "../src/Vault.sol";\ncontract VaultTest {\n    function t(Vault v) external view returns (uint256) { return v.balance(); }\n}\n`,
    });
  });

  it("renames a whole override hierarchy, interfaces included, but not other overloads", async () => {
    const out = await rename(
      {
        "src/I.sol": `${P}interface I {\n    function pay(uint256 a) external;\n    function pay(uint256 a, address b) external;\n}\n`,
        "src/A.sol": `${P}import {I} from "./I.sol";\nabstract contract A is I {\n    function pay(uint256 a) external virtual;\n    function pay(uint256 a, address b) external {}\n}\n`,
        "src/B.sol": `${P}import {A} from "./A.sol";\ncontract B is A {\n    /// @inheritdoc A\n    function |pay(uint256 a) external override {}\n    function go() external { this.pay(1); }\n}\n`,
      },
      "settle",
    );
    expect(out).toEqual({
      "src/I.sol": `${P}interface I {\n    function settle(uint256 a) external;\n    function pay(uint256 a, address b) external;\n}\n`,
      "src/A.sol": `${P}import {I} from "./I.sol";\nabstract contract A is I {\n    function settle(uint256 a) external virtual;\n    function pay(uint256 a, address b) external {}\n}\n`,
      "src/B.sol": `${P}import {A} from "./A.sol";\ncontract B is A {\n    /// @inheritdoc A\n    function settle(uint256 a) external override {}\n    function go() external { this.settle(1); }\n}\n`,
    });
  });

  it("renames interface functions implemented without `override`, past non-ASCII text", async () => {
    const out = await rename(
      {
        "src/I.sol": `${P}// Éste es «un» comentario 🚀\ninterface I {\n    function |ping() external;\n}\n`,
        "src/C.sol": `${P}import {I} from "./I.sol";\n/// Implementación — ✓\ncontract C is I {\n    function ping() external {}\n}\n`,
      },
      "pong",
    );
    expect(out).toEqual({
      "src/I.sol": `${P}// Éste es «un» comentario 🚀\ninterface I {\n    function pong() external;\n}\n`,
      "src/C.sol": `${P}import {I} from "./I.sol";\n/// Implementación — ✓\ncontract C is I {\n    function pong() external {}\n}\n`,
    });
  });

  it("renames struct fields in named arguments and member accesses", async () => {
    const out = await rename(
      {
        "src/Types.sol": `${P}struct Listing {\n    uint256 |price;\n    address seller;\n}\n`,
        "src/Market.sol": `${P}import {Listing} from "./Types.sol";\ncontract Market {\n    function make() external view returns (Listing memory l) {\n        l = Listing({price: 1, seller: msg.sender});\n        l.price += 1;\n    }\n}\n`,
      },
      "amount",
    );
    expect(out).toEqual({
      "src/Types.sol": `${P}struct Listing {\n    uint256 amount;\n    address seller;\n}\n`,
      "src/Market.sol": `${P}import {Listing} from "./Types.sol";\ncontract Market {\n    function make() external view returns (Listing memory l) {\n        l = Listing({amount: 1, seller: msg.sender});\n        l.amount += 1;\n    }\n}\n`,
    });
  });

  it("renames event and error parameters with named arguments and NatSpec", async () => {
    const out = await rename(
      {
        "src/E.sol": `${P}contract E {\n    /// @param |who the caller\n    event Hit(address who);\n    error Bad(uint256 code);\n    function f() external {\n        emit Hit({who: msg.sender});\n        revert Bad({code: 1});\n    }\n}\n`,
      },
      "caller",
    );
    expect(out).toEqual({
      "src/E.sol": `${P}contract E {\n    /// @param caller the caller\n    event Hit(address caller);\n    error Bad(uint256 code);\n    function f() external {\n        emit Hit({caller: msg.sender});\n        revert Bad({code: 1});\n    }\n}\n`,
    });
  });

  it("renames enum values, user-defined value types, free functions, constants and library functions used with `using for`", async () => {
    const files = {
      "src/Lib.sol": `${P}type Price is uint256;\nenum Side { Buy, Sell }\nuint256 constant FEE = 3;\nfunction twice(uint256 x) pure returns (uint256) { return x * 2; }\nlibrary M {\n    function inc(uint256 x) internal pure returns (uint256) { return x + 1; }\n}\n`,
      "src/User.sol": `${P}import {Price, Side, FEE, twice, M} from "./Lib.sol";\ncontract User {\n    using M for uint256;\n    function f(Price p, Side s) external pure returns (uint256) {\n        if (s == Side.Sell) return twice(Price.unwrap(p)).inc() + FEE;\n        return M.inc(FEE);\n    }\n}\n`,
    };
    const mark = (needle: string, rel = "src/Lib.sol") => ({ ...files, [rel]: files[rel as keyof typeof files].replace(needle, `|${needle}`) });
    const user = (out: Record<string, string> | string) => (typeof out === "string" ? out : out["src/User.sol"]);
    expect(user(await rename(mark("Sell"), "Ask"))).toContain("if (s == Side.Ask)");
    expect(user(await rename(mark("Price is"), "Px"))).toContain("import {Px, Side, FEE, twice, M}");
    expect(user(await rename(mark("Price is"), "Px"))).toContain("function f(Px p, Side s)");
    expect(user(await rename(mark("Price is"), "Px"))).toContain("twice(Px.unwrap(p))");
    expect(user(await rename(mark("twice"), "double"))).toContain("return double(Px.unwrap(p))".replace("Px", "Price"));
    expect(user(await rename(mark("FEE ="), "FEE_BPS"))).toContain(".inc() + FEE_BPS;\n        return M.inc(FEE_BPS);");
    expect(user(await rename(mark("inc(uint256"), "plusOne"))).toContain(".plusOne() + FEE;\n        return M.plusOne(FEE);");
  });

  it("keeps import aliases: renaming X updates `{X as Y}` only, renaming Y stays in its file", async () => {
    const files = {
      "src/Token.sol": `${P}contract Token {}\nfunction helper() pure returns (uint256) { return 1; }\n`,
      "src/Use.sol": `${P}import {Token as Tok, helper} from "./Token.sol";\ncontract Use {\n    Tok internal t;\n    function f() external pure returns (uint256) { return helper(); }\n}\n`,
    };
    const out = await rename({ ...files, "src/Token.sol": files["src/Token.sol"].replace("contract Token", "contract |Token") }, "Coin");
    expect(out).toMatchObject({ "src/Use.sol": files["src/Use.sol"].replace("{Token as Tok", "{Coin as Tok") });
    const alias = await rename({ ...files, "src/Use.sol": files["src/Use.sol"].replace("Tok internal", "|Tok internal") }, "T");
    expect(alias).toEqual({ "src/Use.sol": files["src/Use.sol"].replace("Token as Tok", "Token as T").replace("Tok internal", "T internal") });
  });

  it("renames the contract's file and the import paths when the file is named after it", async () => {
    const out = await rename(
      {
        "src/Vault.sol": `${P}contract |Vault {}\n`,
        "src/Router.sol": `${P}import {Vault} from "./Vault.sol";\ncontract Router { Vault internal v; }\n`,
        "test/Router.t.sol": `${P}import "src/Vault.sol";\ncontract RouterTest { Vault internal v; }\n`,
      },
      "Safe",
    );
    expect(out).toEqual({
      "src/Vault.sol": `${P}contract Safe {}\n`,
      "src/Router.sol": `${P}import {Safe} from "./Safe.sol";\ncontract Router { Safe internal v; }\n`,
      "test/Router.t.sol": `${P}import "src/Safe.sol";\ncontract RouterTest { Safe internal v; }\n`,
      "(file)": "src/Vault.sol -> src/Safe.sol",
    });
    // Not when the file holds more than one contract.
    const two = await rename({ "src/Vault.sol": `${P}contract |Vault {}\ncontract Other {}\n` }, "Safe");
    expect(two).not.toHaveProperty("(file)");
  });

  it("refuses library declarations, overrides of library functions and code that does not compile", async () => {
    const lib = { "lib/dep/Base.sol": `${P}abstract contract Base {\n    function hook() internal virtual {}\n}\n` };
    expect(
      await rename({ ...lib, "src/C.sol": `${P}import {Base} from "../lib/dep/Base.sol";\ncontract C is |Base {}\n` }, "Root"),
    ).toMatch(/refused: `Base` is declared in lib\/dep\/Base.sol/);
    expect(
      await rename({ ...lib, "src/C.sol": `${P}import {Base} from "../lib/dep/Base.sol";\ncontract C is Base {\n    function |hook() internal override {}\n}\n` }, "h"),
    ).toMatch(/overrides or implements `Base.hook`, declared in lib\/dep\/Base.sol/);
    expect(await rename({ "src/C.sol": `${P}contract C {\n    uint256 |a;\n    function f() external { b = 1; }\n}\n` }, "x")).toMatch(
      /refused: The project does not compile: src\/C.sol:5:29: Undeclared identifier/,
    );
  });

  it("ignores broken files that cannot refer to the symbol, but not those that import it", async () => {
    const vault = `${P}contract Vault {\n    uint256 public |total;\n}\n`;
    const broken = `${P}contract Draft {\n    function f() external { undefinedThing = 1; }\n}\n`;
    expect(await rename({ "src/Vault.sol": vault, "test/Draft.t.sol": broken }, "sum")).toEqual({
      "src/Vault.sol": vault.replace("|total", "sum"),
    });
    const user = `${P}import {Vault} from "../src/Vault.sol";\ncontract Draft {\n    function f(Vault v) external { v.total(); undefinedThing = 1; }\n}\n`;
    expect(await rename({ "src/Vault.sol": vault, "test/Draft.t.sol": user }, "sum")).toMatch(
      /refused: The project does not compile: test\/Draft.t.sol:5:47: Undeclared identifier/,
    );
  });

  it("refuses names that collide or change what other names refer to", async () => {
    const src = `${P}contract C {\n    uint256 |a;\n    uint256 b;\n    function f() external view returns (uint256) { return a + b; }\n}\n`;
    expect(await rename({ "src/C.sol": src }, "b")).toMatch(/refused: Renaming to `b` would not compile: .*Identifier already declared/);
    expect(await rename({ "src/C.sol": src }, "returns")).toMatch(/reserved word/);
    // A local named like the new name would capture the state variable's uses.
    const shadow = `${P}contract C {\n    uint256 |a;\n    function f() external view returns (uint256) { uint256 b = 2; return a + b; }\n}\n`;
    expect(await rename({ "src/C.sol": shadow }, "b")).toMatch(/refused: /);
  });
});

describe.skipIf(!has("0.8.0") || !has("0.8.13") || !has("0.8.37"))("project rename across solc versions", () => {
  it("compiles files with incompatible pragmas in separate groups and finds name positions without nameLocation", async () => {
    for (const v of ["0.8.0", "0.8.13"]) {
      const old = `// SPDX-License-Identifier: MIT\npragma solidity ${v};\n`;
      const out = await rename(
        {
          "src/Old.sol": `${old}struct S { uint256 |amount; }\ncontract Old {\n    S internal s;\n    function f() external { s = S({amount: 1}); s.amount += 1; }\n}\n`,
          "src/New.sol": `${P}contract New { uint256 internal amount; }\n`,
        },
        "qty",
      );
      expect(out).toEqual({
        "src/Old.sol": `${old}struct S { uint256 qty; }\ncontract Old {\n    S internal s;\n    function f() external { s = S({qty: 1}); s.qty += 1; }\n}\n`,
      });
    }
  });

  it("reports the groups used", async () => {
    const { project, sources } = await fixture({
      "src/Old.sol": `pragma solidity 0.8.13;\ncontract |Old {}\n`,
      "src/New.sol": `${P}contract New {}\n`,
    });
    const ast = await compileWith(project)(sources);
    expect(ast.groups.map((g) => [g.solc, g.files.map((f) => path.basename(f))])).toEqual(
      expect.arrayContaining([
        ["0.8.13", ["Old.sol"]],
        ["0.8.37", ["New.sol"]],
      ]),
    );
  });
});

describe.skipIf(!has("0.8.37"))("find references with solc", () => {
  async function references(files: Record<string, string>): Promise<string[]> {
    const { project, sources, cursor } = await fixture(files);
    const ast = await compileWith(project)(sources);
    return findReferences(ast.index, cursor.file, cursor.offset, sources.get(cursor.file)!)
      .map((r) => {
        const text = sources.get(r.file) ?? fs.readFileSync(r.file, "utf8");
        const line = text.slice(0, r.start).split("\n").length;
        return `${path.relative(project.root, r.file)}:${line}:${text.slice(r.start, r.end)}${r.declaration ? " (declaration)" : ""}`;
      })
      .sort();
  }

  it("lists uses across files, the override hierarchy and library declarations", async () => {
    const lib = { "lib/dep/Base.sol": `${P}abstract contract Base {\n    function hook() internal virtual {}\n}\n` };
    expect(
      await references({
        ...lib,
        "src/C.sol": `${P}import {Base} from "../lib/dep/Base.sol";\ncontract C is Base {\n    function hook() internal virtual override {}\n    function run() external { |hook(); }\n}\n`,
        "src/D.sol": `${P}import {C} from "./C.sol";\ncontract D is C {\n    function hook() internal override { super.hook(); }\n}\n`,
      }),
    ).toEqual([
      "lib/dep/Base.sol:4:hook (declaration)",
      "src/C.sol:5:hook (declaration)",
      "src/C.sol:6:hook",
      "src/D.sol:5:hook",
      "src/D.sol:5:hook (declaration)",
    ]);
  });

  it("includes uses through an import alias, and lists an alias' own uses", async () => {
    const files = {
      "src/Token.sol": `${P}contract Token {}\n`,
      "src/Use.sol": `${P}import {Token as Tok} from "./Token.sol";\ncontract Use {\n    Tok internal t;\n    Tok internal u;\n}\n`,
    };
    expect(await references({ ...files, "src/Token.sol": files["src/Token.sol"].replace("Token {", "|Token {") })).toEqual([
      "src/Token.sol:3:Token (declaration)",
      "src/Use.sol:3:Token",
      "src/Use.sol:5:Tok",
      "src/Use.sol:6:Tok",
    ]);
    expect(await references({ ...files, "src/Use.sol": files["src/Use.sol"].replace("Tok internal u", "|Tok internal u") })).toEqual([
      "src/Use.sol:3:Tok (declaration)",
      "src/Use.sol:5:Tok",
      "src/Use.sol:6:Tok",
    ]);
  });
});

