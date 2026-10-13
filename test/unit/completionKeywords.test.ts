import { describe, expect, it } from "vitest";
import { entries, inBody, labels } from "./completionHelpers";

/** Labels starting with `prefix`, in our order (VS Code keeps it among equal fuzzy scores). */
async function starting(source: string, prefix: string): Promise<string[]> {
  return (await labels(source)).filter((l) => l.startsWith(prefix));
}

describe("types and keywords", () => {
  it("offers address first for `add` in declarations and expressions", async () => {
    expect(await starting(inBody("add|"), "add")).toEqual(["address", "address payable", "addmod"]);
    expect(await starting("contract C { add| }", "add")).toEqual(["address", "address payable"]);
    expect(await starting("contract C { function f(add|) external {} }", "add")).toEqual(["address", "address payable"]);
    expect(await starting(inBody("x = add|"), "add")).toEqual(["address", "addmod"]);
    // Types rank before globals, which rank before auto-imports (sortText starting with 9).
    const all = await entries(inBody("add|"));
    const rankOf = (l: string) => all.find((e) => e.label === l)!.rank;
    expect(rankOf("address")).toBeLessThan(rankOf("addmod"));
    expect(rankOf("addmod")).toBeLessThan(9);
  });

  it("covers the elementary type catalog", async () => {
    const types = (await entries("contract C { | }")).filter((e) => e.kind === "type").map((e) => e.label);
    expect(types).toEqual(expect.arrayContaining(["address", "address payable", "bool", "string", "bytes", "bytes1", "bytes32", "uint8", "uint256", "int8", "int256"]));
    expect(types.filter((t) => /^bytes\d+$/.test(t))).toHaveLength(32);
    expect(types.filter((t) => /^uint\d+$/.test(t))).toHaveLength(32);
    expect(types.filter((t) => /^int\d+$/.test(t))).toHaveLength(32);
    const mapping = (await entries("contract C { | }")).find((e) => e.label === "mapping");
    expect(mapping?.snippet).toBe("mapping(${1:KeyType} => ${2:ValueType})");
  });

  it("suggests keywords by context", async () => {
    expect(await labels("|")).toEqual(expect.arrayContaining(["pragma", "import", "contract", "abstract", "interface", "library", "struct", "function", "uint256"]));
    expect(await labels("abstract |")).toEqual(["contract"]);
    expect(await labels("contract C { | }")).toEqual(expect.arrayContaining(["function", "modifier", "constructor", "receive", "fallback", "event", "error", "mapping"]));
    expect(await labels("contract C { | }")).not.toContain("if");
    expect(await labels(inBody("|"))).toEqual(expect.arrayContaining(["if", "for", "while", "return", "emit", "revert", "unchecked", "try", "delete", "uint256", "true", "msg"]));
    expect(await labels(inBody("|"))).not.toContain("function");
    expect(await labels(inBody("bool ok = |"))).toEqual(expect.arrayContaining(["true", "false", "new", "type", "payable", "uint256"]));
    expect(await labels(inBody("bool ok = |"))).not.toContain("if");
    expect(await labels(inBody("bool ok = |"))).not.toContain("address payable");
  });

  it("suggests data locations only after reference types", async () => {
    expect(await labels(inBody("string |"))).toEqual(["memory", "storage", "calldata"]);
    expect(await labels(inBody("uint256[] |"))).toEqual(["memory", "storage", "calldata"]);
    expect(await labels(inBody("Listing |"))).toEqual(["memory", "storage", "calldata"]);
    expect(await labels(inBody("uint256 |"))).toEqual([]);
    expect(await labels(inBody("address |"))).toEqual(["payable"]);
    expect(await labels("contract C { function f(bytes |) external {} }")).toEqual(["memory", "storage", "calldata"]);
    expect(await labels("contract C { function f(bytes calldata |) external {} }")).toEqual([]);
    expect(await labels("contract C { event E(address |); }")).toEqual(["payable", "indexed"]);
    expect(await labels("contract C { event E(address indexed |); }")).toEqual([]);
  });

  it("suggests state variable attributes, by version and without repeating", async () => {
    expect(await labels("contract C { uint256 | }", { version: "0.8.27" })).toEqual(["public", "private", "internal", "constant", "immutable", "override"]);
    expect(await labels("contract C { uint256 | }", { version: "0.8.28" })).toContain("transient");
    expect(await labels("contract C { uint256 public | }")).toEqual(["constant", "immutable", "transient", "override"]);
    expect(await labels("contract C { uint256 private constant | }")).toEqual(["override"]);
    expect(await labels("uint256 |")).toEqual(["constant"]);
  });

  it("suggests function attributes, without repeating or contradicting", async () => {
    expect(await labels("contract C { function f() | }")).toEqual(["external", "public", "internal", "private", "view", "pure", "payable", "virtual", "override", "returns"]);
    expect(await labels("contract C { function f() external view | }")).toEqual(["virtual", "override", "returns"]);
    expect(await labels("contract C { constructor() | }")).toEqual(["payable"]);
    expect(await labels("contract C { receive() | }")).toEqual(["external", "payable", "virtual", "override"]);
    expect(await labels("contract C { modifier m() | }")).toEqual(["virtual", "override"]);
    // Free functions have no visibility.
    expect(await labels("function f() | ")).toEqual(["view", "pure", "payable", "returns"]);
  });

  it("suggests types where only a type fits", async () => {
    expect(await labels("contract C { mapping(address => |) m; }")).toContain("mapping");
    expect(await labels("contract C { mapping(address => |) m; }")).toContain("uint256");
    expect(await labels("contract C { struct S { | } }")).toEqual(expect.arrayContaining(["uint256", "mapping", "address payable"]));
    expect(await labels("contract C { function f() external returns (|) {} }")).toContain("bool");
    expect(await labels(inBody("x = new |"))).not.toContain("address payable");
    expect(await labels("type Price is |")).not.toContain("address payable");
  });

  it("suggests call options", async () => {
    expect(await labels(inBody('a.call{|}("");'))).toEqual(["value", "gas"]);
    expect(await labels(inBody('a.call{value: 1, |}("");'))).toEqual(["gas"]);
  });
});
