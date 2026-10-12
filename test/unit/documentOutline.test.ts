import { describe, expect, it } from "vitest";
import { analyzeDocument } from "../../src/core/solidity/analyzeDocument";
import type { OutlineNode } from "../../src/core/solidity/documentOutline";

const SRC = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// 🚀 Emoji and ñ before declarations must not shift offsets.
error Unauthorized();
type Shares is uint256;
uint256 constant MAX = 1;
function helper() pure returns (uint256) { return 1; }

struct Position { uint256 amount; address owner; }
enum Side { Long, Short }

abstract contract Vault {
    uint256 public total;
    uint256 private constant FEE = 3;
    address public immutable owner;
    event Deposited(uint256 amount);
    error TooBig();
    modifier onlyOwner() { _; }
    constructor() { owner = msg.sender; }
    receive() external payable {}
    function deposit(uint256 amount) external payable onlyOwner {}
    function preview() public view returns (uint256) { return total; }
}

interface IVault { function deposit(uint256) external; }
library MathLib { function twice(uint256 x) internal pure returns (uint256) { return x * 2; } }
`;

/** name:kind[detail] with children, for compact assertions. */
function shape(nodes: readonly OutlineNode[]): unknown[] {
  return nodes.map((n) => (n.children.length ? [`${n.name}:${n.kind}`, shape(n.children)] : `${n.name}:${n.kind}`));
}

describe("outline", () => {
  const { outline, outlineSource } = analyzeDocument(SRC);

  it("lists top-level declarations and contract members", () => {
    expect(outlineSource).toBe("parser");
    expect(shape(outline)).toEqual([
      "Unauthorized:error",
      "Shares:type",
      "MAX:constant",
      "helper:function",
      ["Position:struct", ["amount:field", "owner:field"]],
      ["Side:enum", ["Long:enumValue", "Short:enumValue"]],
      [
        "Vault:abstract",
        [
          "total:stateVariable",
          "FEE:constant",
          "owner:stateVariable",
          "Deposited:event",
          "TooBig:error",
          "onlyOwner:modifier",
          "constructor:constructor",
          "receive:receive",
          "deposit:function",
          "preview:function",
        ],
      ],
      ["IVault:interface", ["deposit:function"]],
      ["MathLib:library", ["twice:function"]],
    ]);
  });

  it("gives useful details", () => {
    const vault = outline.find((n) => n.name === "Vault")!;
    const detail = (name: string) => vault.children.find((c) => c.name === name)!.detail;
    expect(vault.detail).toBe("abstract contract");
    expect(detail("deposit")).toBe("external payable");
    expect(detail("preview")).toBe("public view");
    expect(detail("total")).toBe("uint256");
    expect(detail("owner")).toBe("address immutable");
    expect(outline.find((n) => n.name === "helper")!.detail).toBe("free function");
  });

  it("uses UTF-16 offsets, with name ranges inside declaration ranges", () => {
    const check = (nodes: readonly OutlineNode[]) => {
      for (const n of nodes) {
        if (n.kind !== "constructor" && n.kind !== "receive") expect(SRC.slice(n.nameStart, n.nameEnd)).toBe(n.name);
        expect(n.nameStart >= n.start && n.nameEnd <= n.end).toBe(true);
        check(n.children);
      }
    };
    check(outline);
    const vault = outline.find((n) => n.name === "Vault")!;
    expect(SRC.slice(vault.start, vault.end)).toMatch(/^abstract contract Vault \{[\s\S]*\}$/);
    expect(SRC.slice(vault.children.find((c) => c.kind === "constructor")!.nameStart).startsWith("constructor")).toBe(true);
  });

  it("still produces an outline while the file is being edited", () => {
    const partial = analyzeDocument("contract A {\n  function f() public {\n}\ncontact B {}\n");
    expect(partial.outline.map((n) => n.name)).toContain("A");
  });
});
