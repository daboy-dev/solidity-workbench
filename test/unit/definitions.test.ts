import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { findDefinitions, sourceFile, type SourceHost } from "../../src/core/navigation/definitions";
import { analyzeDocument } from "../../src/core/solidity/analyzeDocument";

/** An in-memory project; paths are POSIX, relative imports only (remappings are tested elsewhere). */
const FILES: Record<string, string> = {
  "/p/lib/Context.sol": `pragma solidity ^0.8.20;
abstract contract Context {
    function _msgSender() internal view virtual returns (address) { return msg.sender; }
}
`,
  "/p/lib/Ownable.sol": `pragma solidity ^0.8.20;
import {Context} from "./Context.sol";
abstract contract Ownable is Context {
    error OwnableUnauthorizedAccount(address account);
    modifier onlyOwner() { _; }
    function owner() public view returns (address) { return address(0); }
}
`,
  "/p/lib/Math.sol": `pragma solidity ^0.8.20;
library Math {
    function max(uint256 a, uint256 b) internal pure returns (uint256) { return a > b ? a : b; }
    function max(int256 a, int256 b) internal pure returns (int256) { return a > b ? a : b; }
}
`,
  "/p/lib/Reexport.sol": `pragma solidity ^0.8.20;
import {Ownable as BaseOwnable} from "./Ownable.sol";
import "./Math.sol";
`,
  "/p/src/Types.sol": `pragma solidity ^0.8.20;
struct Position { uint256 amount; }
enum Side { Long, Short }
`,
  "/p/src/Vault.sol": `pragma solidity ^0.8.20;
import {Ownable} from "../lib/Ownable.sol";
import {BaseOwnable as O2} from "../lib/Reexport.sol";
import "../lib/Reexport.sol";
import * as T from "./Types.sol";

contract Vault is Ownable {
    T.Position public position;
    function deposit(uint256 x) external onlyOwner {
        address who = _msgSender();
        uint256 m = Math.max(x, 1);
        T.Side s = T.Side.Long;
        revert OwnableUnauthorizedAccount(who);
    }
    function _msgSender() internal view override returns (address) { return super._msgSender(); }
    function self() external view { this.deposit(1); owner(); }
}
`,
};

const host: SourceHost = {
  async load(p) {
    const text = FILES[p];
    return text === undefined ? undefined : sourceFile(p, text, analyzeDocument(text));
  },
  resolveImport: (importPath, importer) => path.posix.normalize(path.posix.join(path.posix.dirname(importer), importPath)),
};

const VAULT = "/p/src/Vault.sol";

/** Resolves the n-th occurrence (0-based) of `needle` in Vault.sol, at its first character + 1. */
async function goTo(needle: string, nth = 0): Promise<string[]> {
  const text = FILES[VAULT]!;
  let at = -1;
  for (let i = 0; i <= nth; i++) at = text.indexOf(needle, at + 1);
  expect(at, needle).toBeGreaterThanOrEqual(0);
  const file = (await host.load(VAULT))!;
  const targets = await findDefinitions(host, file, at + 1);
  return targets.map((t) => `${path.posix.basename(t.path)}:${t.text.slice(t.nameStart, t.nameEnd) || "<file>"}@${lineOf(t.text, t.nameStart)}`);
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

describe("findDefinitions", () => {
  it("opens the file of an import path", async () => {
    expect(await goTo("../lib/Ownable.sol")).toEqual(["Ownable.sol:<file>@1"]);
  });

  it("follows named imports", async () => {
    expect(await goTo("Ownable {")).toEqual(["Ownable.sol:Ownable@3"]);
  });

  it("follows aliases and re-exports", async () => {
    expect(await goTo("O2")).toEqual(["Ownable.sol:Ownable@3"]);
  });

  it("finds inherited members across files", async () => {
    expect(await goTo("onlyOwner")).toEqual(["Ownable.sol:onlyOwner@5"]);
    expect(await goTo("OwnableUnauthorizedAccount")).toEqual(["Ownable.sol:OwnableUnauthorizedAccount@4"]);
    expect(await goTo("owner();")).toEqual(["Ownable.sol:owner@6"]);
  });

  it("prefers the contract's own member over inherited ones", async () => {
    expect(await goTo("_msgSender();")).toEqual(["Vault.sol:_msgSender@15"]);
  });

  it("resolves super and this", async () => {
    expect(await goTo("_msgSender(); }")).toEqual(["Context.sol:_msgSender@3"]);
    expect(await goTo("deposit(1)")).toEqual(["Vault.sol:deposit@9"]);
  });

  it("resolves library members through plain imports, with every overload", async () => {
    expect(await goTo("Math.max")).toEqual(["Math.sol:Math@2"]);
    expect(await goTo("max(x")).toEqual(["Math.sol:max@3", "Math.sol:max@4"]);
  });

  it("resolves unit aliases and their members", async () => {
    expect(await goTo("T.Position")).toEqual(["Types.sol:<file>@1"]);
    expect(await goTo("Position public")).toEqual(["Types.sol:Position@2"]);
    expect(await goTo("Long")).toEqual(["Types.sol:Long@3"]);
  });

  it("does not guess for values, comments and unknown names", async () => {
    expect(await goTo("who);")).toEqual([]);
    expect(await goTo("Vault is")).toEqual(["Vault.sol:Vault@7"]);
    expect(await goTo("pragma")).toEqual([]);
  });
});
