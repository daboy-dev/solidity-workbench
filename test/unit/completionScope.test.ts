import { describe, expect, it } from "vitest";
import { namesInScope, type CompletionEntry } from "../../src/core/completion/complete";
import { at, entries, entriesIn, inBody, labels, memoryHost } from "./completionHelpers";

const LISTING = (cursor: string) => `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Marketplace {
    struct Listing {
        address nftAddress;
        address sellerAddress;
        uint256 tokenId;
        uint256 price;
    }

    uint256 public feeBps;
    address private treasury;
    uint256 constant MAX_PRICE = 1e30;

    function listNFT(address nftAddress_, uint256 tokenId_, uint256 price_) external {
        Listing listing = Listing({
            nftAddress: nftAddress_,
            ${cursor}
        });
    }

    function _check(uint256 amount) internal pure returns (bool) { return amount > 0; }
    function cancel() external {}
}
`;

const labelsOf = (list: readonly CompletionEntry[]) => list.map((e) => e.label);
/** Entries in the order VS Code shows them for an empty prefix (by rank, then our order). */
const shown = (list: readonly CompletionEntry[]) => [...list].sort((a, b) => a.rank - b.rank);

describe("named arguments", () => {
  it("suggests only the missing struct fields left of `:` (the example of the issue)", async () => {
    const list = await entries(LISTING("|"));
    expect(labelsOf(list)).toEqual(["sellerAddress", "tokenId", "price"]);
    expect(list[0]).toMatchObject({ kind: "field", detail: "address", insertText: "sellerAddress: " });
    // Typing the name of an existing argument: no second colon.
    expect((await entries(LISTING("tok|: 1,"))).find((e) => e.label === "tokenId")?.insertText).toBeUndefined();
  });

  it("suggests values right of `:`, matching type and name first", async () => {
    const price = shown(await entries(LISTING("price: |")));
    expect(labelsOf(price).slice(0, 4)).toEqual(["price_", "tokenId_", "feeBps", "MAX_PRICE"]);
    expect(price[0]!.rank).toBeLessThan(price[1]!.rank);
    expect(labelsOf(price)).toEqual(expect.arrayContaining(["nftAddress_", "treasury", "_check", "msg", "block.timestamp", "keccak256", "uint256"]));
    // External functions are not callable without `this.`.
    expect(labelsOf(price)).not.toContain("cancel");

    const seller = shown(await entries(LISTING("sellerAddress: |")));
    expect(labelsOf(seller).slice(0, 3)).toEqual(["nftAddress_", "treasury", "msg.sender"]);
  });

  it("works for function, event and error named arguments", async () => {
    const src = (cursor: string) => `pragma solidity ^0.8.20;
contract C {
    event Sold(address buyer, uint256 amount);
    function pay(address to, uint256 amount) internal {}
    function f(uint256 amount_) external {
        ${cursor}
    }
}`;
    expect(await labels(src("pay({to: msg.sender, |})"))).toEqual(["amount"]);
    expect(await labels(src("emit Sold({|})"))).toEqual(["buyer", "amount"]);
    expect(shown(await entries(src("pay({to: msg.sender, amount: |})")))[0]?.label).toBe("amount_");
  });

  it("resolves structs declared in other files and qualified names", async () => {
    const files = {
      "/p/Types.sol": "pragma solidity ^0.8.20;\nstruct Order { address maker; uint256 amount; }\nlibrary Lib { struct Config { uint16 fee; bool paused; } }\n",
      "/p/Main.sol": 'pragma solidity ^0.8.20;\nimport {Order, Lib} from "./Types.sol";\ncontract M {\n    function f() external {\n        Order memory o = Order({|});\n    }\n}\n',
    };
    expect(labelsOf(await entriesIn(files, "/p/Main.sol"))).toEqual(["maker", "amount"]);
    files["/p/Main.sol"] = files["/p/Main.sol"].replace("Order memory o = Order({|});", "Lib.Config memory c = Lib.Config({fee: 1, |});");
    expect(labelsOf(await entriesIn(files, "/p/Main.sol"))).toEqual(["paused"]);
  });
});

describe("values in scope", () => {
  it("suggests parameters, locals and contract members in expressions", async () => {
    const src = `pragma solidity ^0.8.20;
contract C {
    uint256 total;
    mapping(address => uint256) balances;
    function f(address a, uint256 n) external {
        uint256 doubled = n * 2;
        total = |
    }
}`;
    const list = shown(await entries(src));
    // Same type as the assigned variable first, the variable itself included.
    expect(labelsOf(list).slice(0, 3)).toEqual(["total", "doubled", "n"]);
    expect(labelsOf(list)).toEqual(expect.arrayContaining(["a", "balances"]));
    expect(labelsOf(list)).not.toContain("f"); // external
    expect(list.find((e) => e.label === "doubled")).toMatchObject({ kind: "variable", detail: "uint256" });
    expect(list.find((e) => e.label === "a")).toMatchObject({ kind: "parameter", detail: "address" });
    expect(list.find((e) => e.label === "balances")).toMatchObject({ kind: "field", detail: "mapping(address => uint256)" });
  });

  it("ranks by the return type and by call arguments", async () => {
    const src = (body: string) => `pragma solidity ^0.8.20;
contract C {
    function g(bool flag, address to) internal {}
    function f(address who, bool ok) external returns (bool) {
        ${body}
    }
}`;
    expect(shown(await entries(src("return |")))[0]?.label).toBe("ok");
    expect(shown(await entries(src("g(ok, |)")))[0]?.label).toBe("who");
    expect(shown(await entries(src("require(|)")))[0]?.label).toBe("ok");
  });

  it("suggests the scope at statement start, before keywords and types", async () => {
    const list = shown(await entries(inBody("uint256 local = 1;\n        |")));
    expect(labelsOf(list).slice(0, 3)).toEqual(["local", "a", "n"]);
    expect(labelsOf(list)).toContain("if");
  });

  it("includes inherited members from other files, except private ones", async () => {
    const files = {
      "/p/Base.sol": `pragma solidity ^0.8.20;
abstract contract Base {
    uint256 internal fee;
    address private secret;
    event Paid(address to, uint256 amount);
    error Unauthorized(address caller);
    modifier onlyAdmin() { _; }
    function _helper() internal view returns (uint256) { return fee; }
}`,
      "/p/Main.sol": `pragma solidity ^0.8.20;
import {Base} from "./Base.sol";
contract Main is Base {
    function f() external |
    function g() external {
        uint256 x = |
    }
}`,
    };
    const atMarker = (n: number) => {
      const src = files["/p/Main.sol"];
      let i = -1;
      for (let k = 0; k <= n; k++) i = src.indexOf("|", i + 1);
      // Keep only the n-th marker.
      return { ...files, "/p/Main.sol": src.slice(0, i).replaceAll("|", "") + src.slice(i).replace(/(?<=.)\|/g, "") };
    };
    const header = await entriesIn(atMarker(0), "/p/Main.sol");
    expect(labelsOf(header)).toContain("onlyAdmin");
    expect(header.find((e) => e.label === "onlyAdmin")?.documentation).toBe("Declared in `Base`.");

    const values = labelsOf(await entriesIn(atMarker(1), "/p/Main.sol"));
    expect(values).toEqual(expect.arrayContaining(["fee", "_helper", "Base", "Main"]));
    expect(values).not.toContain("secret");
    expect(values).not.toContain("Paid");
  });

  it("suggests events after emit and errors after revert", async () => {
    const src = (stmt: string) => `pragma solidity ^0.8.20;
error Global();
contract C {
    event Sold(address buyer);
    error TooLow(uint256 price);
    function f() external { ${stmt} }
}`;
    expect(await labels(src("emit |"))).toEqual(["Sold"]);
    expect(await labels(src("revert |"))).toEqual(["TooLow", "Global"]);
    expect((await entries(src("emit |")))[0]?.detail).toBe("Sold(address buyer)");
  });

  it("suggests user-defined types where types fit", async () => {
    const files = {
      "/p/Lib.sol": "pragma solidity ^0.8.20;\ninterface IToken {}\nlibrary SafeMath {}\nabstract contract Owned {}\nstruct Point { uint256 x; }\n",
      "/p/Main.sol": `pragma solidity ^0.8.20;
import "./Lib.sol";
import "./Lib.sol" as L;
contract Main is | {
    enum Side { Buy, Sell }
}`,
    };
    const inheritance = labelsOf(await entriesIn(files, "/p/Main.sol"));
    expect(inheritance).toEqual(expect.arrayContaining(["IToken", "Owned", "L"]));
    expect(inheritance).not.toContain("SafeMath");
    expect(inheritance).not.toContain("Point");

    files["/p/Main.sol"] = files["/p/Main.sol"].replace("contract Main is | {", "contract Main {\n    function f(|) external {}");
    const params = labelsOf(await entriesIn(files, "/p/Main.sol"));
    expect(params).toEqual(expect.arrayContaining(["IToken", "Point", "Side", "uint256", "mapping"]));
    expect(params).not.toContain("SafeMath");
  });

  it("follows named imports with aliases, plain imports transitively, and import cycles", async () => {
    const files = {
      "/p/A.sol": 'pragma solidity ^0.8.20;\nimport "./B.sol";\nstruct FromA { uint256 x; }\n',
      "/p/B.sol": 'pragma solidity ^0.8.20;\nimport "./A.sol";\nuint256 constant FROM_B = 1;\nfunction helperB() pure returns (uint256) { return 1; }\n',
      "/p/Main.sol": 'pragma solidity ^0.8.20;\nimport "./A.sol";\nimport {FromA as Renamed} from "./A.sol";\ncontract M { function f() external { uint256 v = |; } }\n',
    };
    const found = labelsOf(await entriesIn(files, "/p/Main.sol"));
    expect(found).toEqual(expect.arrayContaining(["FROM_B", "helperB", "FromA", "Renamed"]));
  });

  it("lists names in scope for the auto-import to skip", async () => {
    const files = {
      "/p/Base.sol": "pragma solidity ^0.8.20;\ncontract Base { uint256 internal Shares; }\n",
      "/p/Main.sol": 'pragma solidity ^0.8.20;\nimport {Base} from "./Base.sol";\ncontract Main is Base {\n    function f(uint256 Amount) external { uint256 Local = 1; Loc| }\n}\n',
    };
    const names = await namesInScope(at(files["/p/Main.sol"]), { version: "0.8.30", path: "/p/Main.sol", host: memoryHost(files) });
    expect([...names]).toEqual(expect.arrayContaining(["Local", "Amount", "Shares", "Base", "Main", "f"]));
  });
});
