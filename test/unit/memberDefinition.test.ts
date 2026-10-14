import { describe, expect, it } from "vitest";
import { parseStructure } from "../../src/core/completion/structure";
import { memberDefinition } from "../../src/core/navigation/memberDefinition";
import { memoryHost } from "./completionHelpers";

/** Where `|` in `files[file]` goes: `path:line:name`. */
async function definition(files: Record<string, string>, file: string): Promise<string> {
  const source = files[file]!;
  const offset = source.indexOf("|");
  const text = source.replace("|", "");
  const all = { ...files, [file]: text };
  const target = await memberDefinition(parseStructure(text), offset, file, memoryHost(all));
  if (!target) return "(none)";
  return `${target.path}:${target.text.slice(0, target.nameStart).split("\n").length}:${target.text.slice(target.nameStart, target.nameStart + target.name.length)}`;
}

const TYPES = `pragma solidity ^0.8.20;
struct Listing {
    uint256 price;
    address seller;
}
enum Side { Buy, Sell }
interface IToken {
    function transfer(address to, uint256 amount) external returns (bool);
}
library Fees {
    function cut(uint256 x) internal pure returns (uint256) { return x / 100; }
}
`;

const market = (body: string) => `pragma solidity ^0.8.20;
import {Listing, Side, IToken, Fees} from "./Types.sol";
contract Base {
    function hook() internal virtual {}
}
contract Market is Base {
    IToken token;
    mapping(uint256 => Listing) listings;
    function hook() internal override {}
    function f(Listing memory listing) external {
        ${body}
    }
}
`;

describe("member definitions", () => {
  const at = (body: string) => definition({ "/p/Types.sol": TYPES, "/p/Market.sol": market(body) }, "/p/Market.sol");

  it("finds struct fields of locals, parameters, mappings and calls", async () => {
    expect(await at("listing.pr|ice += 1;")).toBe("/p/Types.sol:3:price");
    expect(await at("listings[1].sel|ler;")).toBe("/p/Types.sol:4:seller");
  });

  it("finds functions of contract-typed values, including interfaces in other files", async () => {
    expect(await at("token.trans|fer(address(0), 1);")).toBe("/p/Types.sol:8:transfer");
    expect(await at("IToken(address(0)).trans|fer(address(0), 1);")).toBe("/p/Types.sol:8:transfer");
  });

  it("finds enum values, library functions, this and super members", async () => {
    expect(await at("Side.Se|ll;")).toBe("/p/Types.sol:6:Sell");
    expect(await at("Fees.c|ut(1);")).toBe("/p/Types.sol:11:cut");
    expect(await at("super.ho|ok();")).toBe("/p/Market.sol:4:hook");
  });

  it("returns nothing for names that are not members or cannot be typed", async () => {
    expect(await at("lis|ting.price;")).toBe("(none)");
    expect(await at("unknown.pri|ce;")).toBe("(none)");
    expect(await at("msg.sen|der;")).toBe("(none)");
  });
});
