import { describe, expect, it } from "vitest";
import { entriesIn } from "./completionHelpers";

const FILES = {
  "/p/IERC20.sol": `pragma solidity ^0.8.20;
interface IERC20 {
    event Transfer(address indexed from, address indexed to, uint256 value);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
}
interface IERC20Metadata is IERC20 {
    function decimals() external view returns (uint8);
}
`,
  "/p/Lib.sol": `pragma solidity ^0.8.20;
library PriceLib {
    struct Quote { uint256 price; uint64 at; }
    uint256 internal constant SCALE = 1e18;
    function scale(uint256 x) internal pure returns (uint256) { return x * SCALE; }
    function _secret() private pure {}
}
type Price is uint128;
enum Color { Red, Green }
`,
  "/p/Base.sol": `pragma solidity ^0.8.20;
abstract contract Base {
    uint256 public fee;
    uint256 internal counter;
    function _hook() internal virtual {}
    function owner() public view virtual returns (address) { return address(0); }
    function _hidden() private {}
    function ping() external {}
}
`,
};

/** Labels for the `|` marker in a contract `Market` of /p/Market.sol using the files above. */
async function members(body: string, extraMembers = ""): Promise<string[]> {
  const files = {
    ...FILES,
    "/p/Market.sol": `pragma solidity ^0.8.20;
import {IERC20, IERC20Metadata} from "./IERC20.sol";
import {PriceLib, Price, Color} from "./Lib.sol";
import "./Lib.sol" as L;
import {Base} from "./Base.sol";

contract Market is Base {
    struct Listing { address seller; uint256 price; PriceLib.Quote quote; }
    mapping(uint256 => Listing) internal listings;
    Listing[] internal history;
    IERC20Metadata public token;
    address payable treasury;
    ${extraMembers}

    function getListing(uint256 id) internal view returns (Listing memory) { return listings[id]; }

    function f(uint256 id, address who) external {
        Listing memory listing = listings[id];
        ${body}
    }
}
`,
  };
  return (await entriesIn(files, "/p/Market.sol")).map((e) => e.label);
}

describe("members by declared type", () => {
  it("suggests struct fields of variables, mapping values, array elements and returned structs", async () => {
    expect(await members("listing.|")).toEqual(["seller", "price", "quote"]);
    expect(await members("listings[id].|")).toEqual(["seller", "price", "quote"]);
    expect(await members("history[0].|")).toEqual(["seller", "price", "quote"]);
    expect(await members("getListing(id).|")).toEqual(["seller", "price", "quote"]);
    // Nested structs declared elsewhere, and elementary members at the end of a chain.
    expect(await members("listing.quote.|")).toEqual(["price", "at"]);
    expect(await members("listing.seller.|")).toEqual(["balance", "code", "codehash", "call", "delegatecall", "staticcall"]);
    expect(await members("history.|")).toEqual(["length", "push", "pop"]);
  });

  it("suggests the external interface of contract-typed values, inherited functions included", async () => {
    expect(await members("token.|")).toEqual(["decimals", "totalSupply", "balanceOf", "transfer"]);
    expect(await members("IERC20(who).|")).toEqual(["totalSupply", "balanceOf", "transfer"]);
    // Calls return their declared type.
    expect(await members("token.balanceOf(who).|")).toEqual([]);
  });

  it("suggests this, super and payable state variables", async () => {
    expect(await members("this.|")).toEqual(["token", "f", "fee", "owner", "ping"]);
    expect(await members("super.|")).toEqual(["fee", "counter", "_hook", "owner"]);
    expect(await members("treasury.|")).toEqual(expect.arrayContaining(["transfer", "send", "balance"]));
    expect(await members("this.f.|")).toEqual(["selector", "address"]);
  });

  it("suggests members of libraries, enums, value types and unit aliases", async () => {
    expect(await members("PriceLib.|")).toEqual(["Quote", "SCALE", "scale"]);
    expect(await members("Color.|")).toEqual(["Red", "Green"]);
    expect(await members("Price.|")).toEqual(["wrap", "unwrap"]);
    expect(await members("L.|")).toEqual(expect.arrayContaining(["PriceLib", "Price", "Color"]));
    expect(await members("IERC20.|")).toEqual(["Transfer", "totalSupply", "balanceOf", "transfer"]);
    expect(await members("IERC20.transfer.|")).toEqual(["selector"]);
  });

  it("suggests type(X) members according to what X is", async () => {
    expect(await members("type(IERC20).|")).toEqual(["name", "interfaceId"]);
    expect(await members("type(Market).|")).toEqual(["name", "creationCode", "runtimeCode"]);
    expect(await members("type(Color).|")).toEqual(["min", "max"]);
  });

  it("marks public state variables seen from outside as getters", async () => {
    const files = { ...FILES, "/p/User.sol": 'pragma solidity ^0.8.20;\nimport {Base} from "./Base.sol";\ncontract User { Base b; function f() external { b.| } }\n' };
    const list = await entriesIn(files, "/p/User.sol");
    expect(list.map((e) => e.label)).toEqual(["fee", "owner", "ping"]);
    expect(list.find((e) => e.label === "fee")?.kind).toBe("method");
  });
});
