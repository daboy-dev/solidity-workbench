import { describe, expect, it } from "vitest";
import { parseStructure } from "../../src/core/completion/structure";
import { applyEdits, localSymbolAt, renameLocal } from "../../src/core/references/locals";

/**
 * `source` marks the cursor with `|` and the expected occurrences with `«»`.
 * Returns the source as found: markers removed, occurrences found wrapped in `«»`.
 */
function found(source: string): string {
  const { text, cursor } = strip(source);
  const symbol = localSymbolAt(parseStructure(text), cursor);
  if (!symbol) return "(nothing)";
  let out = "";
  let last = 0;
  for (const o of symbol.occurrences) {
    out += `${text.slice(last, o.start)}«${text.slice(o.start, o.end)}»`;
    last = o.end;
  }
  return out + text.slice(last);
}

function strip(source: string): { text: string; cursor: number } {
  const cursor = source.replace(/[«»]/g, "").indexOf("|");
  if (cursor < 0) throw new Error("no | marker");
  return { text: source.replace(/[«»|]/g, ""), cursor };
}

const expected = (source: string) => source.replace(/\|/g, "");

function check(source: string): void {
  expect(found(source)).toBe(expected(source));
}

function rename(source: string, newName: string): string {
  const { text, cursor } = strip(source);
  const structure = parseStructure(text);
  const symbol = localSymbolAt(structure, cursor);
  if (!symbol) return "(nothing)";
  const result = renameLocal(structure, symbol, newName);
  return result.ok ? applyEdits(text, result.edits) : `refused: ${result.reason}`;
}

describe("local references", () => {
  it("finds a parameter from its declaration and from a use", () => {
    check(`contract C {
    uint256 a;
    function f(uint256 «|a», uint256 b) external returns (uint256) {
        return «a» + b + this.a();
    }
}`);
    check(`contract C {
    function f(uint256 «a») external pure returns (uint256) {
        return «a|» * 2;
    }
    function g(uint256 a) external pure returns (uint256) { return a; }
}`);
  });

  it("respects blocks and shadowing", () => {
    check(`contract C {
    function f(uint256 x) external {
        uint256 «|y» = x;
        {
            uint256 y = 2;
            y += 1;
        }
        «y» += 1;
    }
}`);
    check(`contract C {
    function f(uint256 x) external {
        uint256 y = x;
        {
            uint256 «y» = 2;
            «y|» += 1;
        }
        y += 1;
    }
}`);
  });

  it("makes a local visible only after its declaration statement", () => {
    check(`contract C {
    uint256 total;
    function f() external {
        total = 1;
        uint256 «|total» = total + 1;
        «total» += 2;
    }
}`);
  });

  it("handles named returns, for loops, try/catch and tuple declarations", () => {
    check(`contract C {
    function f() external returns (uint256 «|sum») {
        for (uint256 i; i < 3; i++) «sum» += i;
    }
}`);
    check(`contract C {
    function f(uint256[] memory xs) external pure returns (uint256 s) {
        for (uint256 «|i» = 0; «i» < xs.length; ++«i») {
            s += xs[«i»];
        }
        for (uint256 i = 0; i < 2; i++) s += i;
    }
}`);
    check(`contract C {
    function f(I target) external {
        try target.g() returns (uint256 «|v», bool) {
            emit Done(«v»);
        } catch Error(string memory reason) {
            revert(reason);
        } catch (bytes memory) {}
    }
}`);
    check(`contract C {
    function f(I target) external {
        try target.g() returns (uint256 v, bool) {
        } catch Error(string memory «reason») {
            revert(«reason|»);
        }
    }
}`);
    check(`contract C {
    function f() external {
        (uint256 a, , bool «|ok») = g();
        require(«ok» && a > 0);
    }
}`);
  });

  it("ignores members, named-argument keys and call options with the same name", () => {
    check(`contract C {
    struct S { uint256 amount; }
    function f(uint256 «|amount», address to) external {
        S memory s = S({amount: «amount»});
        s.amount = «amount»;
        payable(to).call{value: «amount»}("");
    }
}`);
  });

  it("finds uses inside inline assembly", () => {
    check(`contract C {
    function f(uint256 «|x») external pure returns (uint256 r) {
        assembly {
            r := add(«x», 1)
        }
    }
}`);
  });

  it("covers modifiers and their arguments in function headers", () => {
    check(`contract C {
    modifier only(address «|who») {
        require(msg.sender == «who»);
        _;
    }
    function f(address who) external only(who) {}
}`);
    check(`contract C {
    modifier only(address who) { _; }
    function f(address «a|») external only(«a») {}
}`);
  });

  it("works on half-written code", () => {
    check(`contract C {
    function f(uint256 amount) external {
        uint256 «|fee» = amount / 100;
        if (amount > 0) {
            «fee» +=
    }
    function g() external {}
}`);
    check(`contract C {
    function f(uint256 «amount») external {
        uint256 fee = «amount|» / 100
        uint256 rest = «amount» - fee
`);
  });

  it("returns nothing for non-locals", () => {
    expect(found(`contract C { uint256 a; function f() external { |a = 1; } }`)).toBe("(nothing)");
    expect(found(`contract C { function f() external { |g(); } function g() internal {} }`)).toBe("(nothing)");
  });
});

describe("renaming locals", () => {
  it("renames every occurrence and the NatSpec tags", () => {
    expect(
      rename(
        `contract C {
    /// @notice Adds.
    /// @param a first value
    /// @return sum the result
    function f(uint256 |a) external pure returns (uint256 sum) {
        sum = a + 1;
    }
}`,
        "first",
      ),
    ).toBe(`contract C {
    /// @notice Adds.
    /// @param first first value
    /// @return sum the result
    function f(uint256 first) external pure returns (uint256 sum) {
        sum = first + 1;
    }
}`);
    expect(rename(`contract C {\n    /** @return sum total */\n    function f() external pure returns (uint256 |sum) { sum = 1; }\n}`, "total")).toBe(
      `contract C {\n    /** @return total total */\n    function f() external pure returns (uint256 total) { total = 1; }\n}`,
    );
  });

  it("refuses invalid and reserved names", () => {
    const src = `contract C { function f(uint256 |a) external {} }`;
    expect(rename(src, "1x")).toMatch(/not a valid Solidity identifier/);
    expect(rename(src, "returns")).toMatch(/reserved word/);
    expect(rename(src, "uint8")).toMatch(/type/);
    expect(rename(src, "msg")).toMatch(/global name/);
    expect(rename(src, "layout")).toBe(`contract C { function f(uint256 layout) external {} }`);
  });

  it("refuses names declared in an enclosing or enclosed scope", () => {
    expect(rename(`contract C { function f(uint256 |a, uint256 b) external {} }`, "b")).toMatch(/already declared/);
    expect(rename(`contract C { function f(uint256 |a) external { { uint256 b = a; } } }`, "b")).toMatch(/already declared/);
    // Sibling blocks are independent.
    expect(rename(`contract C { function f() external { { uint256 |a = 1; a++; } { uint256 b = 2; b++; } } }`, "b")).toBe(
      `contract C { function f() external { { uint256 b = 1; b++; } { uint256 b = 2; b++; } } }`,
    );
  });

  it("refuses a rename that captures a state variable or function", () => {
    expect(rename(`contract C { uint256 total; function f(uint256 |a) external { total = a; } }`, "total")).toMatch(/capture/);
    // Shadowing is allowed when the shadowed name is not used in the scope.
    expect(rename(`contract C { uint256 total; function f(uint256 |a) external { a++; } }`, "total")).toBe(
      `contract C { uint256 total; function f(uint256 total) external { total++; } }`,
    );
  });
});
