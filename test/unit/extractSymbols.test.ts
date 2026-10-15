import { describe, expect, it } from "vitest";
import { extractMembersWithRegex, extractSymbols, extractSymbolsWithRegex } from "../../src/core/solidity/extractSymbols";

const ALL_KINDS = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {X} from "./X.sol";

error Unauthorized(address who);
event Transfer(address from, address to);
type Price is uint128;
uint256 constant MAX_SUPPLY = 1e24;
function freeAdd(uint a, uint b) pure returns (uint) { return a + b; }
struct Order { uint id; }
enum Status { Open, Closed }
abstract contract Base {
    struct Inner { uint x; }
    error InnerError();
    function inner() public {}
}
interface IThing {}
library MathLib {}
contract Thing is Base, IThing {}
`;

const EXPECTED = [
  ["Unauthorized", "error"],
  ["Transfer", "event"],
  ["Price", "type"],
  ["MAX_SUPPLY", "constant"],
  ["freeAdd", "function"],
  ["Order", "struct"],
  ["Status", "enum"],
  ["Base", "abstract"],
  ["IThing", "interface"],
  ["MathLib", "library"],
  ["Thing", "contract"],
];

describe("extractSymbols", () => {
  it("extracts every kind of top-level declaration with the parser", () => {
    const result = extractSymbols(ALL_KINDS);
    expect(result.method).toBe("parser");
    expect(result.symbols.filter((s) => !s.container).map((s) => [s.name, s.kind])).toEqual(EXPECTED);
  });

  it("reports 0-based positions", () => {
    const thing = extractSymbols(ALL_KINDS).symbols.find((s) => s.name === "Thing")!;
    expect(thing.line).toBe(19);
    expect(thing.character).toBe(0);
  });

  it("indexes errors, events, structs and enums of contracts with their container, not their functions", () => {
    const members = extractSymbols(ALL_KINDS).symbols.filter((s) => s.container);
    expect(members.map((s) => [s.name, s.kind, s.container])).toEqual([
      ["Inner", "struct", "Base"],
      ["InnerError", "error", "Base"],
    ]);
    expect(members[1]).toMatchObject({ line: 14, character: 4 });
    expect(extractSymbols(ALL_KINDS).symbols.map((s) => s.name)).not.toContain("inner");
  });

  it("finds members with the regex scan too, on broken files", () => {
    const broken = `pragma solidity ^0.8.20;
interface IERC721Errors {
    error ERC721NonexistentToken(uint256 tokenId);
    event Seen(uint256 id);
}
contract Broken {
    struct S { uint a; }
    function f( {
        error NotAMember();
}
`;
    const result = extractSymbols(broken);
    expect(result.method).not.toBe("parser");
    expect(result.symbols.filter((s) => s.container).map((s) => `${s.container}.${s.name}`)).toEqual(
      expect.arrayContaining(["IERC721Errors.ERC721NonexistentToken", "IERC721Errors.Seen", "Broken.S"]),
    );
    expect(extractMembersWithRegex(broken).map((s) => s.name)).not.toContain("NotAMember");
    expect(extractSymbolsWithRegex(broken).map((s) => s.name)).not.toContain("ERC721NonexistentToken");
  });

  it("completes the parser result with the regex scan on broken files", () => {
    const broken = `pragma solidity ^0.8.0;
contract Good {}
contract Broken {
  function f( {
}
library AfterBreak {}
`;
    const result = extractSymbols(broken);
    expect(result.method).not.toBe("parser");
    expect(result.symbols.map((s) => s.name)).toEqual(expect.arrayContaining(["Good", "Broken"]));
  });
});

describe("extractSymbolsWithRegex", () => {
  it("finds the same top-level declarations as the parser", () => {
    expect(extractSymbolsWithRegex(ALL_KINDS).map((s) => [s.name, s.kind])).toEqual(EXPECTED);
  });

  it("ignores declarations in comments and strings", () => {
    const src = `// contract Commented {}
/* library Blocked {} */
string constant S = "contract InString {}";
contract Real {}`;
    expect(extractSymbolsWithRegex(src).map((s) => s.name)).toEqual(["S", "Real"]);
  });

  it("does not mistake function types for free functions", () => {
    const src = `contract A { function (uint) external f; }`;
    expect(extractSymbolsWithRegex(src).map((s) => s.name)).toEqual(["A"]);
  });
});
