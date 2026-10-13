import { describe, expect, it } from "vitest";
import { at, inBody } from "./completionHelpers";

const site = (src: string) => at(src).site;

describe("cursor context", () => {
  it("detects member accesses and parses the receiver", () => {
    expect(site(inBody("msg.|"))).toEqual({ kind: "member", receiver: { kind: "name", name: "msg" } });
    expect(site(inBody("msg.sen|"))).toEqual({ kind: "member", receiver: { kind: "name", name: "msg" } });
    expect(site(inBody("payable(msg.sender).|"))).toEqual({
      kind: "member",
      receiver: { kind: "call", callee: { kind: "name", name: "payable" }, args: 1 },
    });
    expect(site(inBody("type(uint8).|"))).toEqual({ kind: "member", receiver: { kind: "typeOf", type: "uint8" } });
    expect(site(inBody("a.b[1].c(2, 3).|"))).toMatchObject({
      kind: "member",
      receiver: { kind: "call", args: 2, callee: { kind: "member", name: "c", object: { kind: "index" } } },
    });
    expect(site(inBody("x.call{value: 1}(\"\").|"))).toMatchObject({ kind: "member", receiver: { kind: "call" } });
  });

  it("says nothing in comments, strings, imports, pragmas, assembly and number literals", () => {
    expect(site(inBody("// msg.|"))).toEqual({ kind: "none" });
    expect(site(inBody('string memory s = "msg.|";'))).toEqual({ kind: "none" });
    expect(site('import {A} from "./A|.sol";')).toEqual({ kind: "none" });
    expect(site("pragma solidity ^0.8.|;")).toEqual({ kind: "none" });
    expect(site(inBody("assembly { let x := mload(|) }"))).toEqual({ kind: "none" });
    expect(site(inBody("uint256 x = 12|"))).toEqual({ kind: "none" });
  });

  it("detects units after a number", () => {
    expect(site(inBody("uint256 x = 1 |"))).toEqual({ kind: "unit" });
    expect(site(inBody("uint256 x = 1 eth|"))).toEqual({ kind: "unit" });
  });

  it("classifies statement and expression positions", () => {
    expect(site(inBody("|"))).toEqual({ kind: "statement" });
    expect(site(inBody("ad|"))).toEqual({ kind: "statement" });
    expect(site(inBody("uint256 b = 1;\n        |"))).toEqual({ kind: "statement" });
    expect(site(inBody("uint256 x = |"))).toEqual({ kind: "expression", expected: { kind: "type", type: "uint256", name: "x" } });
    expect(site(inBody("uint256 x = 1 + |"))).toMatchObject({ kind: "expression" });
    expect(site(inBody("require(|);"))).toEqual({ kind: "expression", expected: { kind: "type", type: "bool" } });
    expect(site(inBody("n = |"))).toEqual({ kind: "expression", expected: { kind: "sameAs", expr: { kind: "name", name: "n" } } });
    expect(site(inBody("return |"))).toEqual({ kind: "expression", expected: { kind: "return" } });
    expect(site(inBody("emit |"))).toEqual({ kind: "expression", keyword: "emit" });
    expect(site(inBody("revert |"))).toEqual({ kind: "expression", keyword: "revert" });
    expect(site(inBody("x = new |"))).toEqual({ kind: "typeName", purpose: "new" });
    expect(site(inBody("f(a, |)"))).toEqual({ kind: "expression", expected: { kind: "arg", callee: { kind: "name", name: "f" }, index: 1 } });
    // After a complete operand an operator is expected.
    expect(site(inBody("uint256 x = n |"))).toEqual({ kind: "none" });
  });

  it("classifies declarations in bodies", () => {
    expect(site(inBody("string |"))).toEqual({ kind: "afterType", type: "string", where: "local", used: [] });
    expect(site(inBody("Listing memory |"))).toEqual({ kind: "none" });
    expect(site(inBody("for (|"))).toEqual({ kind: "statement" });
    expect(site(inBody("for (uint256 i = 0; i < |"))).toMatchObject({ kind: "expression" });
  });

  it("classifies named arguments", () => {
    const src = (cursor: string) => inBody(`Listing memory l = Listing({\n    nftAddress: a,\n    ${cursor}\n});`);
    expect(site(src("|"))).toEqual({ kind: "namedArgName", callee: { kind: "name", name: "Listing" }, given: ["nftAddress"] });
    expect(site(src("price: |"))).toEqual({
      kind: "expression",
      expected: { kind: "namedArg", callee: { kind: "name", name: "Listing" }, name: "price" },
    });
    expect(site(inBody('a.call{|}("");'))).toEqual({ kind: "callOption", given: [] });
  });

  it("classifies contract-level positions", () => {
    expect(site("contract C { | }")).toEqual({ kind: "contractLevel" });
    expect(site("contract C { uint256 | }")).toEqual({ kind: "afterType", type: "uint256", where: "state", used: [] });
    expect(site("contract C { uint256 public | }")).toEqual({ kind: "afterType", type: "uint256", where: "state", used: ["public"] });
    expect(site("contract C { uint256 constant X = | }")).toEqual({ kind: "expression", expected: { kind: "type", type: "uint256", name: "X" } });
    expect(site("contract C { mapping(address => |) m; }")).toEqual({ kind: "typeName", purpose: "mapping" });
    expect(site("contract C { struct S { | } }")).toEqual({ kind: "structField" });
    expect(site("contract C { enum E { A, | } }")).toEqual({ kind: "none" });
    expect(site("contract C { event E(address |); }")).toEqual({ kind: "afterType", type: "address", where: "eventParam", used: [] });
    expect(site("contract C { using S|")).toEqual({ kind: "typeName", purpose: "using" });
  });

  it("classifies function headers", () => {
    expect(site("contract C { function f(|) external {} }")).toEqual({ kind: "typeName", purpose: "param" });
    expect(site("contract C { function f(uint256 a, |) external {} }")).toEqual({ kind: "typeName", purpose: "param" });
    expect(site("contract C { function f(string |) external {} }")).toEqual({ kind: "afterType", type: "string", where: "param", used: [] });
    expect(site("contract C { function f(string memory s) ex| }")).toEqual({ kind: "functionAttributes", callable: "function", used: [] });
    expect(site("contract C { function f() external view | {} }")).toEqual({ kind: "functionAttributes", callable: "function", used: ["external", "view"] });
    // Multi-line headers.
    expect(site("contract C {\n    function f(uint256 a)\n        external\n        |\n}")).toEqual({ kind: "functionAttributes", callable: "function", used: ["external"] });
    expect(site("contract C { function f() external returns (|) {} }")).toEqual({ kind: "typeName", purpose: "param" });
    expect(site("contract C { function f() external onlyRole(|) {} }")).toMatchObject({ kind: "expression" });
    expect(site("contract C { function |")).toEqual({ kind: "none" });
  });

  it("classifies file-level positions", () => {
    expect(site("|")).toEqual({ kind: "fileLevel" });
    expect(site("pragma solidity ^0.8.20;\n|")).toEqual({ kind: "fileLevel" });
    expect(site("contract C is | {}")).toEqual({ kind: "typeName", purpose: "inheritance" });
    expect(site("contract C is A, | {}")).toEqual({ kind: "typeName", purpose: "inheritance" });
    expect(site("abstract |")).toEqual({ kind: "afterAbstract" });
    expect(site("contract C {}\n|")).toEqual({ kind: "fileLevel" });
  });

  it("collects the parameters and locals visible at the cursor, innermost first", () => {
    const names = (src: string) => at(src).locals.map((d) => d.name);
    expect(names(inBody("uint256 b = 1;\n        |"))).toEqual(["b", "a", "n"]);
    // Not visible before their declaration, nor in their own initializer.
    expect(names(inBody("|\n        uint256 b = 1;"))).toEqual(["a", "n"]);
    expect(names(inBody("uint256 b = |"))).toEqual(["a", "n"]);
    // Block scoping.
    expect(names(inBody("{ uint256 inner = 1; }\n        |"))).toEqual(["a", "n"]);
    expect(names(inBody("for (uint256 i = 0; i < n; i++) { | }"))).toEqual(["i", "a", "n"]);
    // Shadowing keeps the innermost declaration.
    expect(at(inBody("{ bool a = true; | }")).locals.find((d) => d.name === "a")?.type).toBe("bool");
    // Named returns, tuple declarations, try/catch.
    expect(names(inBody("|", "function f() external returns (uint256 total)"))).toEqual(["total"]);
    expect(names(inBody("(uint256 x, , bool y) = g();\n        |"))).toEqual(["y", "x", "a", "n"]);
    expect(names(inBody("try t.f() returns (uint256 v) { | } catch {}"))).toEqual(["v", "a", "n"]);
    expect(names(inBody("try t.f() {} catch Error(string memory reason) { | }"))).toEqual(["reason", "a", "n"]);
  });

  it("is tolerant to half-written code", () => {
    // The example from the issue: trailing comma, missing data location, cursor in the literal.
    const src = `pragma solidity ^0.8.20;
contract Market {
    struct Listing { address nftAddress; address sellerAddress; uint256 tokenId; uint256 price; }
    function listNFT(address nftAddress_, uint256 tokenId_, uint256 price_) external {
        Listing listing = Listing({
            nftAddress: nftAddress_,
            |
        });
    }
    function other() external {}
}`;
    const ctx = at(src);
    expect(ctx.site).toMatchObject({ kind: "namedArgName", given: ["nftAddress"] });
    expect(ctx.locals.map((d) => d.name)).toEqual(["nftAddress_", "tokenId_", "price_"]);
    expect(ctx.contract?.members.map((m) => m.name)).toEqual(["Listing", "listNFT", "other"]);

    // Missing semicolon: the next line is still a statement of its own.
    const missing = at(inBody("uint256 b = 1\n        |"));
    expect(missing.site).toEqual({ kind: "statement" });
    expect(missing.locals.map((d) => d.name)).toContain("b");

    // An unclosed body does not hide the members declared after it.
    const unclosed = at("contract C {\n    function f() external {\n        |\n    function g() external {}\n    uint256 total;\n}");
    expect(unclosed.site).toEqual({ kind: "statement" });
    expect(unclosed.contract?.members.map((m) => m.name)).toEqual(["f", "g", "total"]);

    // An unclosed parameter list neither.
    const params = at("contract C {\n    function f(uint256 a, |\n    function g() external {}\n}");
    expect(params.site).toEqual({ kind: "typeName", purpose: "param" });
    expect(params.contract?.members.map((m) => m.name)).toEqual(["f", "g"]);
  });
});
