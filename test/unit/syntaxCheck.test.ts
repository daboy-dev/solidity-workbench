import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeDocument } from "../../src/core/solidity/analyzeDocument";
import { damerauLevenshtein, describeParserError, checkTrailingCommas } from "../../src/core/solidity/syntaxCheck";

/** Problems as [code, text at the range, message]. */
function problems(src: string): Array<[string, string, string]> {
  return analyzeDocument(src).problems.map((p) => [p.code, src.slice(p.start, p.end), p.message]);
}

describe("keyword typos", () => {
  it("reports misspelled top-level keywords with a fix", () => {
    const [p] = analyzeDocument("pragma solidity ^0.8.20;\ncontact Vault {}\n").problems;
    expect(p).toMatchObject({ code: "keyword-typo", fix: "contract", message: "Unknown keyword `contact`. Did you mean `contract`?" });
    expect(problems("contact Vault is Base {}\n")[0]?.[1]).toBe("contact");
    expect(problems("intrface IThing {}\n")[0]?.[2]).toContain("`interface`");
    expect(problems("libary Math {}\n")[0]?.[2]).toContain("`library`");
    expect(problems("abstact contract A {}\n")[0]?.[2]).toContain("`abstract`");
    expect(problems("evnt Transfer(address to);\n")[0]?.[2]).toContain("`event`");
  });

  it("reports misspelled members inside contracts", () => {
    expect(problems("contract V {\n  fucntion deposit() public {}\n}\n")).toEqual([
      ["keyword-typo", "fucntion", "Unknown keyword `fucntion`. Did you mean `function`?"],
    ]);
    expect(problems("contract V {\n  constuctor() {}\n}\n")[0]?.[2]).toContain("`constructor`");
    expect(problems("contract V {\n  modifer onlyOwner() { _; }\n}\n")[0]?.[2]).toContain("`modifier`");
    expect(problems("contract V {\n  recieve() external payable {}\n}\n")[0]?.[2]).toContain("`receive`");
  });

  it("does not flag user-defined types used as variables", () => {
    expect(problems("contract V {\n  Contact contact;\n  Contact public c = Contact(address(0));\n}\n")).toEqual([]);
    expect(problems("Contact constant C = Contact.wrap(1);\n")).toEqual([]);
  });
});

describe("brackets", () => {
  it("points at the block left open in the middle of a file, using indentation", () => {
    const src = "contract Vault {\n  function f() public {\n    uint a = 1;\n\n  function g() public {}\n}\n";
    expect(problems(src)).toEqual([["unclosed-bracket", "{", "Missing `}` to close `function f` (opened on line 2)."]]);
    expect(src.indexOf("{", src.indexOf("function f"))).toBe(analyzeDocument(src).problems[0]!.start);
  });

  it("reports blocks still open at the end of the file", () => {
    const msgs = problems("contract Vault {\n  function f() public {\n    uint a = 1;\n").map((p) => p[2]);
    expect(msgs).toEqual([
      "Missing `}` to close `contract Vault` (opened on line 1).",
      "Missing `}` to close `function f` (opened on line 2).",
    ]);
  });

  it("labels unnamed blocks", () => {
    expect(problems("contract V {\n  function f() public {\n    if (true) {\n      x();\n  }\n}\n")[0]?.[2]).toBe(
      "Missing `}` to close the `if` block (opened on line 3).",
    );
  });

  it("reports extra closing brackets", () => {
    expect(problems("contract V {\n  function f() public {}\n}\n}\n")).toEqual([
      ["unexpected-bracket", "}", "Unexpected `}`: there is nothing to close."],
    ]);
    expect(problems("contract V {\n  function f() public { g(1)); }\n}\n")).toEqual([
      ["unexpected-bracket", ")", "Unexpected `)`: there is no `(` to close."],
    ]);
  });

  it("reports a parenthesis closed by a brace", () => {
    expect(problems("contract V {\n  function f() public { g(1; }\n}\n")).toEqual([
      ["mismatched-bracket", "(", "Missing `)` to close `(` before `}` on line 2."],
    ]);
  });

  it("ignores brackets in comments and strings", () => {
    expect(problems('contract V {\n  // }\n  /* { */\n  string s = "}}{";\n  bytes b = hex"7b7d";\n}\n')).toEqual([]);
  });
});

describe("parser errors", () => {
  it("reports a missing semicolon at the end of the statement", () => {
    const src = "contract V {\n  function f() public {\n    uint a = 1\n    a++;\n  }\n}\n";
    expect(problems(src)).toEqual([["parser", "1", "Missing `;`."]]);
  });

  it("rewrites ANTLR messages", () => {
    expect(describeParserError("extraneous input ')' expecting ';'")).toBe("Unexpected `)`. Expected `;`.");
    expect(describeParserError("mismatched input '(' expecting {';', '='}")).toBe("Unexpected `(`. Expected `;` or `=`.");
    expect(describeParserError("extraneous input '<EOF>' expecting {'a', 'b', 'c', 'd'}")).toBe("Unexpected end of file.");
    expect(describeParserError("no viable alternative at input 'uint x'")).toBe("Syntax error near `x`.");
    expect(describeParserError("token recognition error at: '#'")).toBe("Invalid character `#`.");
  });

  it("does not repeat the cascade of errors after our own diagnosis", () => {
    const src = "contract V {\n  fucntion deposit() public {}\n}\n";
    expect(analyzeDocument(src).problems).toHaveLength(1);
  });
});

describe("valid code", () => {
  const tricky = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "./IERC20.sol";
import "./Lib.sol" as Lib;

type Price is uint128;
using {add as +} for Price global;
function add(Price a, Price b) pure returns (Price) { return Price.wrap(Price.unwrap(a) + Price.unwrap(b)); }

contract Storage layout at 0x1234 {
    uint256 transient lock;
    IERC20 public immutable token;
    mapping(address account => uint256 balance) balances;
    function (uint256) external returns (uint256) callback;
    error Fail(string reason);
    event Done(uint256 indexed id);

    constructor(IERC20 t) { token = t; }
    receive() external payable {}
    fallback() external {}

    modifier guarded() { require(lock == 0, "locked {"); lock = 1; _; lock = 0; }

    function run(uint256 x) external guarded returns (uint256 y) {
        unchecked { y = x + 1; }
        try this.other() returns (uint256 v) { y = v; } catch Error(string memory) { revert Fail("}"); } catch {}
        assembly { let z := add(x, 1) if gt(z, 2) { mstore(0, z) } }
        y = type(uint256).max;
        emit Done(y);
    }

    function other() external pure returns (uint256) { return 1; }
}
`;

  it("reports nothing for valid code with tricky constructs", () => {
    expect(problems(tricky)).toEqual([]);
  });

  it("reports nothing for the fixture project", () => {
    const root = path.resolve(__dirname, "../fixtures/foundry-project");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (f.endsWith(".sol")) files.push(f);
      }
    };
    walk(root);
    for (const f of files) expect([f, problems(fs.readFileSync(f, "utf8"))]).toEqual([f, []]);
  });
});

describe("damerauLevenshtein", () => {
  it("counts transpositions as a single edit", () => {
    expect(damerauLevenshtein("fucntion", "function")).toBe(1);
    expect(damerauLevenshtein("contact", "contract")).toBe(1);
    expect(damerauLevenshtein("abc", "abc")).toBe(0);
    expect(damerauLevenshtein("", "abc")).toBe(3);
  });
});

describe("trailing commas", () => {
  /** The comma and the closer it precedes, for each problem. */
  const commas = (src: string) => checkTrailingCommas(src).map((p) => /^,\s*./.exec(src.slice(p.start))![0].replace(/\s+/g, ""));

  it("reports them in struct literals, calls, parameter lists, enums and arrays", () => {
    expect(commas("L memory l = L({\n    a: a_,\n});")).toEqual([",}"]);
    expect(commas("f(1, 2, );")).toEqual([",)"]);
    expect(commas("function f(uint a,) {}")).toEqual([",)"]);
    expect(commas("function f() returns (uint a,) {}")).toEqual([",)"]);
    expect(commas("enum E { A, B, }")).toEqual([",}"]);
    expect(commas("x = [1, 2,];")).toEqual([",]"]);
    expect(commas('a.call{value: 1,}("");')).toEqual([",}"]);
    expect(commas('import {A, B,} from "x.sol";')).toEqual([",}"]);
    expect(checkTrailingCommas("f(1,)")[0]).toMatchObject({ code: "trailing-comma", message: "Trailing comma before `)` is not allowed.", fix: "" });
  });

  it("accepts empty tuple components", () => {
    expect(commas('(bool ok, ) = a.call("");')).toEqual([]);
    expect(commas("(, uint256 b) = g();")).toEqual([]);
    expect(commas("return (a, );")).toEqual([]);
    expect(commas("abi.decode(data, (uint256, bool))")).toEqual([]);
  });

  it("explains the example of the issue better than the parser", () => {
    const src = "pragma solidity ^0.8.20;\ncontract M {\n  struct L { address a; }\n  function f(address a_) external {\n    L memory l = L({\n      a: a_,\n    });\n  }\n}\n";
    const problems = analyzeDocument(src).problems;
    expect(problems.map((p) => p.message)).toEqual(["Trailing comma before `}` is not allowed."]);
  });
});
