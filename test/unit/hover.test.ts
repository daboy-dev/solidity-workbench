import { describe, expect, it } from "vitest";
import { parseStructure } from "../../src/core/completion/structure";
import { hoverAt, type HoverEnv } from "../../src/core/hover/hover";
import { inBody, memoryHost } from "./completionHelpers";

/** The hover at the `|` marker of `files[file]`: its code lines, or "(none)". */
async function hoverIn(files: Record<string, string>, file: string, env: Partial<HoverEnv> = {}): Promise<string> {
  const source = files[file]!;
  const offset = source.indexOf("|");
  if (offset < 0) throw new Error("no | marker");
  const text = source.replace("|", "");
  const hover = await hoverAt(parseStructure(text), offset, { version: "0.8.30", path: file, host: memoryHost({ ...files, [file]: text }), ...env });
  return hover ? hover.sections.map((s) => s.code).join("\n") : "(none)";
}

const hover = (source: string, env: Partial<HoverEnv> = {}) => hoverIn({ "/p/C.sol": source }, "/p/C.sol", env);

async function docOf(source: string, env: Partial<HoverEnv> = {}): Promise<string> {
  const offset = source.indexOf("|");
  const text = source.replace("|", "");
  const h = await hoverAt(parseStructure(text), offset, { version: "0.8.30", ...env });
  return h?.sections[0]?.doc ?? "(none)";
}

describe("hover on builtins", () => {
  it("shows msg, block, tx and abi members with their type", async () => {
    expect(await hover(inBody("address s = msg.sen|der;"))).toBe("address msg.sender");
    expect(await hover(inBody("uint256 t = block.|timestamp;"))).toBe("uint256 block.timestamp");
    expect(await hover(inBody("tx.orig|in;"))).toBe("address tx.origin");
    expect(await hover(inBody("bytes memory b = abi.enc|ode(1);"))).toBe("function abi.encode(...) returns (bytes memory)");
    expect(await docOf(inBody("msg.sen|der;"))).toBe("Sender of the message (current call).");
  });

  it("works at both ends of the name", async () => {
    expect(await hover(inBody("msg.|sender;"))).toBe("address msg.sender");
    expect(await hover(inBody("msg.sender|;"))).toBe("address msg.sender");
  });

  it("shows global functions and global names", async () => {
    expect(await hover(inBody("bytes32 h = kecc|ak256(abi.encode(n));"))).toBe("function keccak256(bytes memory) returns (bytes32)");
    expect(await hover(inBody("requi|re(n > 0);"))).toBe("function require(bool condition, string memory message)");
    expect(await hover(inBody("m|sg.sender;"))).toBe("msg");
    expect(await hover(inBody("address(th|is);"))).toBe("this");
  });

  it("follows the file's solc version", async () => {
    expect(await docOf(inBody("block.prevra|ndao;"), { version: "0.8.10" })).toContain("Not available in solc 0.8.10: added in 0.8.18.");
    expect(await docOf(inBody("block.difficu|lty;"), { version: "0.8.20" })).toContain("Deprecated since 0.8.18: use `block.prevrandao`.");
    expect(await docOf(inBody("block.difficu|lty;"), { version: "0.8.17" })).not.toContain("Deprecated");
    expect(await docOf(inBody("payable(a).trans|fer(1);"), { version: "0.8.31" })).toContain("Deprecated since 0.8.31");
  });

  it("shows members of elementary values, arrays and function pointers", async () => {
    expect(await hover(inBody("a.bala|nce;"))).toBe("uint256 address.balance");
    expect(await hover(inBody("a.ca|ll(\"\");"))).toBe("function address.call(bytes memory) returns (bool, bytes memory)");
    expect(await hover(inBody("uint256[] memory xs; xs.len|gth;"))).toBe("uint256 uint256[].length");
    expect(await hover(inBody("bytes.con|cat(\"a\");"))).toBe("function bytes.concat(...) returns (bytes memory)");
    expect(await hover(inBody("this.f.selec|tor;"))).toBe("bytes4 function.selector");
  });

  it("shows type(X) members", async () => {
    expect(await hover(inBody("type(uint8).m|ax;"))).toBe("uint8 type(uint8).max");
    const source = `pragma solidity ^0.8.20;
interface I {}
enum Side { Buy, Sell }
contract C {
    function f() external {
        type(I).interface|Id;
        type(C).na|me;
        type(Side).m|in;
    }
}
`;
    const cut = (marker: number) => source.split("|").reduce((acc, part, i) => acc + (i === 0 ? "" : i === marker ? "|" : "") + part);
    expect(await hover(cut(1))).toBe("bytes4 type(I).interfaceId");
    expect(await hover(cut(2))).toBe("string type(C).name");
    expect(await hover(cut(3))).toBe("Side type(Side).min");
  });

  it("shows units after numbers", async () => {
    expect(await hover(inBody("uint256 x = 1 eth|er;"))).toBe("1 ether");
    expect(await docOf(inBody("uint256 x = 2 da|ys;"))).toBe("Time unit: `1 days` is 86400 seconds.");
  });

  it("stays quiet in comments, strings, shadowing locals and user-defined members", async () => {
    expect(await hover(inBody("// msg.sen|der"))).toBe("(none)");
    expect(await hover(inBody('string memory s = "msg.sen|der";'))).toBe("(none)");
    expect(await hover(inBody("uint256 keccak256 = 1; kecc|ak256;"))).toBe("(none)");
    const source = `pragma solidity ^0.8.20;
struct S { uint256 length; }
contract C {
    function f(S memory s) external { s.len|gth; }
}
`;
    expect(await hover(source)).toBe("(none)");
    expect(await hover("pragma sol|idity ^0.8.20;")).toBe("(none)");
  });
});
