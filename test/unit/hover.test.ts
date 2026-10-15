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

  it("stays quiet in comments and strings, and lets locals and user-defined members win", async () => {
    expect(await hover(inBody("// msg.sen|der"))).toBe("(none)");
    expect(await hover(inBody('string memory s = "msg.sen|der";'))).toBe("(none)");
    expect(await hover(inBody("uint256 keccak256 = 1; kecc|ak256;"))).toBe("uint256 keccak256");
    const source = `pragma solidity ^0.8.20;
struct S { uint256 length; }
contract C {
    function f(S memory s) external { s.len|gth; }
}
`;
    expect(await hover(source)).toBe("uint256 S.length");
    expect(await hover("pragma sol|idity ^0.8.20;")).toBe("(none)");
  });
});

const TYPES = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice A listed item.
struct Listing {
    uint256 price;
    address seller;
}

enum Side { Buy, Sell }

uint256 constant FEE_BPS = 25; // basis points

/**
 * @title Token interface
 * @notice Moves tokens.
 */
interface IToken {
    /// @notice Sends \`amount\` tokens to \`to\`.
    /// @dev Reverts on failure.
    /// @param to The recipient.
    /// @param amount How much to send.
    /// @return ok Always true.
    function transfer(address to, uint256 amount) external returns (bool ok);
}
`;

const VAULT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {Listing, Side, IToken, FEE_BPS} from "./Types.sol";

abstract contract Base {
    /// @notice Called after every deposit.
    function hook(uint256 amount) internal virtual;
}

contract Vault is Base {
    /// Total deposited.
    uint256 public totalDeposits = 0;
    IToken internal immutable token;
    mapping(address owner => uint256 balance) public balances;
    event Deposited(address indexed who, uint256 amount);
    error TooSmall(uint256 amount, uint256 minimum);

    /// @notice Deposits \`amount\`.
    /// @param amount Wei to deposit.
    /// @return shares Shares minted.
    function deposit(uint256 amount, Listing memory listing) external returns (uint256 shares) {
        BODY
    }

    function pay(address to) external {}
    function pay(address to, uint256 amount) external {}

    function hook(uint256 amount) internal override {}
}
`;

describe("hover on project symbols", () => {
  const at = (body: string) => hoverIn({ "/p/Types.sol": TYPES, "/p/Vault.sol": VAULT.replace("BODY", body) }, "/p/Vault.sol");
  const full = async (body: string) => {
    const files = { "/p/Types.sol": TYPES, "/p/Vault.sol": VAULT.replace("BODY", body) };
    const source = files["/p/Vault.sol"];
    const offset = source.indexOf("|");
    const text = source.replace("|", "");
    const h = await hoverAt(parseStructure(text), offset, { version: "0.8.30", path: "/p/Vault.sol", host: memoryHost({ ...files, "/p/Vault.sol": text }) });
    return h?.sections ?? [];
  };

  it("shows parameters and locals with their @param and @return text", async () => {
    expect(await at("amou|nt;")).toBe("uint256 amount");
    expect((await full("amou|nt;"))[0]?.doc).toBe("Wei to deposit.");
    expect((await full("shar|es = 1;"))[0]?.doc).toBe("Shares minted.");
    expect(await at("listi|ng.price;")).toBe("Listing memory listing");
    expect(await at("uint256 x = 1; x|;")).toBe("uint256 x");
  });

  it("shows state variables, events, errors and constants", async () => {
    expect(await at("totalDep|osits;")).toBe("uint256 public totalDeposits");
    expect((await full("totalDep|osits;"))[0]?.doc).toBe("Total deposited.");
    expect(await at("bal|ances[msg.sender];")).toBe("mapping(address owner => uint256 balance) public balances");
    expect(await at("emit Depos|ited(msg.sender, amount);")).toBe("event Deposited(address indexed who, uint256 amount)");
    expect(await at("revert TooSm|all(amount, 1);")).toBe("error TooSmall(uint256 amount, uint256 minimum)");
    expect(await at("FEE_B|PS;")).toBe("uint256 constant FEE_BPS = 25");
  });

  it("shows functions with their NatSpec, from other files too", async () => {
    expect(await at("token.trans|fer(msg.sender, amount);")).toBe("function transfer(address to, uint256 amount) external returns (bool ok)");
    const doc = (await full("token.trans|fer(msg.sender, amount);"))[0]?.doc ?? "";
    expect(doc).toContain("Sends `amount` tokens to `to`.");
    expect(doc).toContain("Reverts on failure.");
    expect(doc).toContain("*@param* `to` — The recipient.");
    expect(doc).toContain("*@return* `ok` — Always true.");
    expect(doc).toContain("*Declared in `IToken` (Types.sol).*");
  });

  it("shows types: structs, enums, contracts and their members", async () => {
    expect(await at("Listi|ng memory l;")).toBe("struct Listing {\n    uint256 price;\n    address seller;\n}");
    expect((await full("Listi|ng memory l;"))[0]?.doc).toBe("A listed item.");
    expect(await at("Si|de s;")).toBe("enum Side { Buy, Sell }");
    expect(await at("Side.Se|ll;")).toBe("Side.Sell");
    expect(await at("listing.pri|ce;")).toBe("uint256 Listing.price");
    expect(await at("IT|oken t;")).toBe("interface IToken");
    expect((await full("IT|oken t;"))[0]?.doc).toBe("**Token interface**\n\nMoves tokens.");
  });

  it("shows inherited members and super calls with where they come from", async () => {
    expect(await at("super.ho|ok(amount);")).toBe("function hook(uint256 amount) internal virtual");
    expect((await full("super.ho|ok(amount);"))[0]?.doc).toBe("Called after every deposit.\n\n*Declared in `Base` (Vault.sol).*");
    // The override in this contract wins over the base.
    expect(await at("ho|ok(amount);")).toBe("function hook(uint256 amount) internal override");
  });

  it("picks overloads by argument count", async () => {
    expect(await at("pa|y(msg.sender);")).toBe("function pay(address to) external");
    expect(await at("this.pa|y(msg.sender, 1);")).toBe("function pay(address to, uint256 amount) external");
    expect(await at("pa|y;")).toBe("function pay(address to) external\nfunction pay(address to, uint256 amount) external");
  });

  it("shows the declaration under the cursor", async () => {
    const source = VAULT.replace("function dep", "function dep|").replace("BODY", "");
    expect(await hoverIn({ "/p/Types.sol": TYPES, "/p/Vault.sol": source }, "/p/Vault.sol")).toBe(
      "function deposit(uint256 amount, Listing memory listing) external returns (uint256 shares)",
    );
    expect(await hoverIn({ "/p/Types.sol": TYPES, "/p/Vault.sol": VAULT.replace("contract Vault", "contract Va|ult").replace("BODY", "") }, "/p/Vault.sol")).toBe(
      "contract Vault is Base",
    );
  });

  it("breaks long parameter lists", async () => {
    const source = `pragma solidity ^0.8.20;
contract C {
    function settle(address seller, address buyer, uint256 price, uint256 deadline, bytes calldata signature) external returns (bool) {}
    function f() external { sett|le; }
}
`;
    expect(await hover(source)).toBe(
      "function settle(\n    address seller,\n    address buyer,\n    uint256 price,\n    uint256 deadline,\n    bytes calldata signature\n) external returns (bool)",
    );
  });

  it("falls back to solc's AST for what the parser cannot resolve", async () => {
    const text = VAULT.replace("BODY", "amount.mulDiv(1, 2);");
    const offset = text.indexOf("mulDiv") + 1;
    const lib = "pragma solidity ^0.8.20;\nlibrary Math {\n    function mulDiv(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {}\n}\n";
    const host = memoryHost({ "/p/Types.sol": TYPES, "/p/Vault.sol": text, "/p/Math.sol": lib });
    const ast = (o: number) => (o === offset - 1 ? { path: "/p/Math.sol", nameStart: lib.indexOf("mulDiv") } : undefined);
    const h = await hoverAt(parseStructure(text), offset, { version: "0.8.30", path: "/p/Vault.sol", host, ast });
    expect(h?.sections[0]?.code).toBe("function mulDiv(uint256 x, uint256 y, uint256 d) internal pure returns (uint256)");
  });
});

describe("hover on elementary types", () => {
  it("shows ranges and sizes", async () => {
    expect(await docOf(inBody("ui|nt8 x;"))).toBe("Unsigned integer of 8 bits: 0 to 255. Members of `type(uint8)`: `min`, `max`.");
    expect(await docOf(inBody("in|t16 x;"))).toContain("Signed integer of 16 bits: -32768 to 32767.");
    expect(await docOf(inBody("ui|nt x;"))).toContain("0 to 2**256 - 1. Alias of `uint256`.");
    expect(await docOf(inBody("in|t256 x;"))).toContain("-2**255 to 2**255 - 1.");
    expect(await docOf(inBody("byt|es32 x;"))).toBe("Fixed-size byte array of 32 bytes. Members: `length`.");
    expect(await hover(inBody("addr|ess payable p;"))).toBe("address payable");
    expect(await hover("pragma solidity ^0.8.20;\ncontract C { function f(bo|ol b) external {} }")).toBe("bool");
  });
});

describe("hover with inherited NatSpec", () => {
  const BASES = `pragma solidity ^0.8.20;
interface IVault {
    /// @notice Deposits assets.
    /// @param assets How much.
    /// @return shares Minted shares.
    function deposit(uint256 assets) external returns (uint256 shares);
}
`;
  const impl = (doc: string) => `pragma solidity ^0.8.20;
import {IVault} from "./IVault.sol";
contract Vault is IVault {
    ${doc}
    function deposit(uint256 assets) external returns (uint256 shares) {}
    function f() external { this.dep|osit(1); }
}
`;
  const docAt = async (doc: string) => {
    const files = { "/p/IVault.sol": BASES, "/p/Vault.sol": impl(doc) };
    const source = files["/p/Vault.sol"];
    const offset = source.indexOf("|");
    const text = source.replace("|", "");
    const h = await hoverAt(parseStructure(text), offset, { version: "0.8.30", path: "/p/Vault.sol", host: memoryHost({ ...files, "/p/Vault.sol": text }) });
    return h?.sections[0]?.doc ?? "(none)";
  };

  it("takes the overridden function's NatSpec when there is none", async () => {
    expect(await docAt("")).toBe("Deposits assets.\n\n*@param* `assets` — How much.\n\n*@return* `shares` — Minted shares.");
  });

  it("follows @inheritdoc and adds the function's own tags", async () => {
    expect(await docAt("/// @inheritdoc IVault\n    /// @dev Rounds down.")).toBe(
      "Deposits assets.\n\nRounds down.\n\n*@param* `assets` — How much.\n\n*@return* `shares` — Minted shares.",
    );
  });

  it("keeps its own NatSpec otherwise", async () => {
    expect(await docAt("/// @notice Mine.")).toBe("Mine.");
  });
});

describe("NatSpec comments", () => {
  it("reads /** */ blocks and ignores plain comments", async () => {
    const source = (comment: string) => `pragma solidity ^0.8.20;\ncontract C {\n    ${comment}\n    uint256 x;\n    function f() external { x|; }\n}\n`;
    expect(await docOf(source("/**\n     * @notice Counter.\n     * @dev Starts at zero.\n     */"))).toBe("Counter.\n\nStarts at zero.");
    expect(await docOf(source("// plain"))).toBe("(none)");
    expect(await docOf(source("/// @custom:security non-reentrant"))).toBe("*@custom:security* non-reentrant");
  });
});

describe("hover on selectors", () => {
  it("shows the selector of errors and events", async () => {
    const source = `pragma solidity ^0.8.20;
contract M {
    error PriceZero();
    event Listed(uint256 id);
    function f() external pure returns (bytes32) { return M.PriceZero.sel|ector ^ Listed.selector; }
}
`;
    expect(await hover(source)).toBe("bytes4 PriceZero.selector");
    expect(await hover(source.replace("sel|ector", "selector").replace("Listed.selector", "Listed.sel|ector"))).toBe("bytes32 Listed.selector");
  });
});
