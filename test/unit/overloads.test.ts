import { describe, expect, it } from "vitest";
import { parseStructure } from "../../src/core/completion/structure";
import { hoverAt } from "../../src/core/hover/hover";
import { calledOverloads, memberDefinitions } from "../../src/core/navigation/memberDefinition";
import { entriesIn, memoryHost } from "./completionHelpers";

const TYPES = `pragma solidity ^0.8.20;
interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
}
abstract contract ERC20 is IERC20 {}
contract Token is ERC20 {}
struct Listing { uint256 price; address seller; }
library Pay {
    function send(IERC20 token, address to) internal {}
    function send(address to, uint256 amount) internal {}
    function send(address to, string memory memo) internal {}
}
`;

const VAULT = (body: string) => `pragma solidity ^0.8.20;
import {IERC20, Token, Listing, Pay} from "./Types.sol";
contract Vault {
    Token token;
    event Paid(address to, uint256 amount);
    event Paid(address to, string memo);
    function get(uint256 id) public view returns (Listing memory) {}
    function get(address who) public view returns (uint256) {}
    function put(address to, uint256 amount) internal {}
    function put(uint256 amount, address to) internal {}
    function put(uint8 small) internal {}
    function put(uint256 big) internal {}
    function f(uint256 n, address who, int256 delta, bool flag) external {
        ${body}
    }
}
`;

function at(body: string): { text: string; offset: number; files: Record<string, string> } {
  const source = VAULT(body);
  const offset = source.indexOf("|");
  const text = source.replace("|", "");
  return { text, offset, files: { "/p/Types.sol": TYPES, "/p/Vault.sol": text } };
}

async function hover(body: string): Promise<string[]> {
  const { text, offset, files } = at(body);
  const h = await hoverAt(parseStructure(text), offset, { version: "0.8.30", path: "/p/Vault.sol", host: memoryHost(files) });
  return h ? h.sections.map((s) => s.code) : [];
}

async function lines(targets: Promise<Array<{ text: string; nameStart: number }>>): Promise<number[]> {
  return (await targets).map((t) => t.text.slice(0, t.nameStart).split("\n").length);
}

describe("overloads chosen by argument types", () => {
  it("hovers the overload the arguments convert to", async () => {
    expect(await hover("ge|t(who);")).toEqual(["function get(address who) public view returns (uint256)"]);
    expect(await hover("ge|t(n);")).toEqual(["function get(uint256 id) public view returns (Listing memory)"]);
    expect(await hover("pu|t(who, 1);")).toEqual(["function put(address to, uint256 amount) internal"]);
    expect(await hover("pu|t(n, msg.sender);")).toEqual(["function put(uint256 amount, address to) internal"]);
  });

  it("takes literals, derived contracts and named arguments into account", async () => {
    expect(await hover('Pay.se|nd(who, "thanks");')).toEqual(["function send(address to, string memory memo) internal"]);
    expect(await hover("Pay.se|nd(who, 5);")).toEqual(["function send(address to, uint256 amount) internal"]);
    // `Token` derives from `IERC20`.
    expect(await hover("Pay.se|nd(token, who);")).toEqual(["function send(IERC20 token, address to) internal"]);
    expect(await hover("pu|t({amount: n, to: who});")).toHaveLength(2);
    expect(await hover("emit Pa|id(who, n);")).toEqual(["event Paid(address to, uint256 amount)"]);
  });

  it("keeps every overload that fits when the arguments do not decide", async () => {
    // A number literal fits both `uint8` and `uint256`; `n + 1` cannot be typed.
    expect(await hover("pu|t(1);")).toHaveLength(2);
    expect(await hover("pu|t(n + 1, who);")).toHaveLength(1);
    expect(await hover("pu|t(n + 1, n + 2);")).toHaveLength(2);
    // Nothing fits the types: those taking as many arguments.
    expect(await hover("pu|t(flag, flag);")).toHaveLength(2);
    // A call being written: all of them.
    expect(await hover("pu|t(")).toHaveLength(4);
  });

  it("types calls with the overload they reach", async () => {
    const labels = async (body: string) => (await entriesIn({ "/p/Types.sol": TYPES, "/p/Vault.sol": VAULT(body) }, "/p/Vault.sol")).map((e) => e.label);
    expect(await labels("get(n).|")).toContain("seller");
    expect(await labels("get(who).|")).not.toContain("seller");
  });

  it("ranks arguments with the overloads the previous arguments can reach", async () => {
    const ranks = async (body: string) => {
      const entries = await entriesIn({ "/p/Types.sol": TYPES, "/p/Vault.sol": VAULT(body) }, "/p/Vault.sol");
      return (label: string) => entries.find((e) => e.label === label)!.rank;
    };
    const afterAddress = await ranks("put(who, |");
    expect(afterAddress("n")).toBeLessThan(afterAddress("who"));
    const afterNumber = await ranks("put(n, |");
    expect(afterNumber("who")).toBeLessThan(afterNumber("n"));
  });
});

describe("definitions of overloads", () => {
  it("go to the overloads a member call reaches", async () => {
    const { text, offset, files } = at("Pay.se|nd(who, 5);");
    expect(await lines(memberDefinitions(parseStructure(text), offset, "/p/Vault.sol", memoryHost(files)))).toEqual([10]);
  });

  it("narrow calls by name to the overloads their arguments reach", async () => {
    const run = (body: string) => {
      const { text, offset, files } = at(body);
      return lines(calledOverloads(parseStructure(text), offset, "/p/Vault.sol", memoryHost(files)));
    };
    expect(await run("ge|t(who);")).toEqual([8]);
    expect(await run("pu|t(1);")).toEqual([11, 12]);
    // Every overload fits: nothing to narrow.
    expect(await run("ge|t(n + 1);")).toEqual([]);
  });
});

describe("arguments typed for overloads", () => {
  const CLOCK = (body: string) => `pragma solidity ^0.8.20;
library Clock {
    function mode(function() view returns (uint48) clock) internal view returns (string memory) {}
    function mode(uint48 timepoint) internal pure returns (string memory) {}
    function check(bytes memory data) internal pure {}
    function check(bytes32 digest) internal pure {}
}
contract C {
    function clock() public view returns (uint48) {}
    function f(function() view returns (uint48) fn, bytes32 h) external {
        ${body}
    }
}
`;
  const hoverIn = async (body: string) => {
    const source = CLOCK(body);
    const offset = source.indexOf("|");
    const text = source.replace("|", "");
    const h = await hoverAt(parseStructure(text), offset, { version: "0.8.30", path: "/p/C.sol", host: memoryHost({ "/p/C.sol": text }) });
    return h ? h.sections.map((s) => s.code) : [];
  };

  it("passes functions as values, calls variables of function type and types abi calls", async () => {
    expect(await hoverIn("Clock.mo|de(clock);")).toEqual(["function mode(function() view returns (uint48) clock) internal view returns (string memory)"]);
    expect(await hoverIn("Clock.mo|de(fn());")).toEqual(["function mode(uint48 timepoint) internal pure returns (string memory)"]);
    expect(await hoverIn("Clock.che|ck(abi.encodePacked(h));")).toEqual(["function check(bytes memory data) internal pure"]);
    expect(await hoverIn("Clock.che|ck(h);")).toEqual(["function check(bytes32 digest) internal pure"]);
  });
});
