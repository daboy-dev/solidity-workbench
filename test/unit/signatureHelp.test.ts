import { describe, expect, it } from "vitest";
import { parseStructure } from "../../src/core/completion/structure";
import { signatureHelpAt, type SignatureHelp } from "../../src/core/signature/signature";
import { memoryHost } from "./completionHelpers";

const TYPES = `pragma solidity ^0.8.20;
interface IERC20 {
    /// @notice Moves tokens.
    /// @param to The receiver.
    /// @param value How many.
    function transfer(address to, uint256 value) external returns (bool);
}
library SafeERC20 {
    function safeTransfer(IERC20 token, address to, uint256 value) internal {}
}
struct Listing { uint256 price; address seller; }
abstract contract Ownable {
    /// @param initialOwner Who owns it.
    constructor(address initialOwner) {}
    modifier onlyRole(bytes32 role) { _; }
}
contract Token {
    constructor(string memory name, uint8 decimals) {}
}
`;

const VAULT = (body: string, header = "") => `pragma solidity ^0.8.20;
import {IERC20, SafeERC20, Listing, Ownable, Token} from "./Types.sol";
contract Vault is Ownable {
    using SafeERC20 for IERC20;
    IERC20 token;
    event Paid(address indexed to, uint256 amount);
    error TooLow(uint256 given, uint256 min);
    function put(address to, uint256 amount) internal {}
    function put(uint256 amount) internal {}
    function f(uint256 n, address who) external ${header} {
        ${body}
    }
}
`;

async function help(body: string, header = ""): Promise<SignatureHelp | undefined> {
  const source = VAULT(body, header);
  const offset = source.indexOf("|");
  const text = source.replace("|", "");
  return signatureHelpAt(parseStructure(text), offset, { version: "0.8.30", path: "/p/Vault.sol", host: memoryHost({ "/p/Types.sol": TYPES, "/p/Vault.sol": text }) });
}

/** The active signature, with the active parameter between brackets. */
async function shown(body: string, header = ""): Promise<string> {
  const h = await help(body, header);
  if (!h) return "(none)";
  const s = h.signatures[h.activeSignature]!;
  const p = s.parameters[s.activeParameter];
  return p ? `${s.label.slice(0, p.label[0])}[${s.label.slice(p.label[0], p.label[1])}]${s.label.slice(p.label[1])}` : s.label;
}

describe("signature help", () => {
  it("shows the parameter at the cursor of members and their NatSpec", async () => {
    expect(await shown("token.transfer(|")).toBe("function transfer([address to], uint256 value) returns (bool)");
    expect(await shown("token.transfer(who, |")).toBe("function transfer(address to, [uint256 value]) returns (bool)");
    expect(await shown("token.transfer(who, f(1, 2), |")).toBe("function transfer(address to, uint256 value) returns (bool)");
    const h = (await help("token.transfer(|"))!;
    expect(h.signatures[0]!.documentation).toBe("Moves tokens.");
    expect(h.signatures[0]!.parameters.map((p) => p.documentation)).toEqual(["The receiver.", "How many."]);
  });

  it("leaves out the value of functions attached with using for", async () => {
    expect(await shown("token.safeTransfer(|")).toBe("function safeTransfer([address to], uint256 value)");
  });

  it("lists every overload and selects the one the arguments reach", async () => {
    const h = (await help("put(|"))!;
    expect(h.signatures.map((s) => s.label)).toEqual(["function put(address to, uint256 amount)", "function put(uint256 amount)"]);
    expect(await shown("put(n|")).toBe("function put([uint256 amount])");
    expect(await shown("put(wh|")).toBe("function put([address to], uint256 amount)");
    expect(await shown("put(who, |")).toBe("function put(address to, [uint256 amount])");
    expect(await shown("put(n, |")).toBe("function put(address to, [uint256 amount])");
    expect((await help("put(n|"))!.activeSignature).toBe(1);
    expect((await help("put(5 + n|)"))!.activeSignature).toBe(0);
  });

  it("covers events, errors, structs, constructors and modifiers", async () => {
    expect(await shown("emit Paid(who, |")).toBe("event Paid(address indexed to, [uint256 amount])");
    expect(await shown("revert TooLow(|")).toBe("error TooLow([uint256 given], uint256 min)");
    expect(await shown("Listing memory l = Listing(1, |")).toBe("struct Listing(uint256 price, [address seller])");
    expect(await shown("Listing memory l = Listing({seller: |")).toBe("struct Listing(uint256 price, [address seller])");
    expect(await shown("Listing memory l = Listing({price: 1, |")).toBe("struct Listing(uint256 price, [address seller])");
    expect(await shown('new Token("x", |')).toBe("new Token(string memory name, [uint8 decimals])");
    expect(await shown("", "onlyRole(|)")).toBe("modifier onlyRole([bytes32 role])");
  });

  it("covers base constructors in contract headers", async () => {
    const text = `pragma solidity ^0.8.20;\nimport {Ownable} from "./Types.sol";\ncontract C is Ownable(msg.sender) {}\n`;
    const offset = text.indexOf("msg.sender");
    const h = await signatureHelpAt(parseStructure(text), offset, { version: "0.8.30", path: "/p/C.sol", host: memoryHost({ "/p/Types.sol": TYPES, "/p/C.sol": text }) });
    expect(h?.signatures[0]?.label).toBe("Ownable(address initialOwner)");
    expect(h?.signatures[0]?.parameters[0]?.documentation).toBe("Who owns it.");
  });

  it("covers built-in functions, variadic ones included", async () => {
    expect(await shown("require(n > 0, |")).toBe("require(bool condition, [string memory message])");
    expect(await shown("keccak256(|")).toBe("keccak256([bytes memory]) returns (bytes32)");
    expect(await shown("abi.encode(n, who, |")).toBe("abi.encode([...]) returns (bytes memory)");
    expect(await shown("abi.encodeWithSelector(0x12345678, |")).toBe("abi.encodeWithSelector(bytes4 selector, [...]) returns (bytes memory)");
  });

  it("covers allocations, wrap and unwrap, variables of function type and calls in modifier arguments", async () => {
    expect(await shown("bytes memory b = new bytes(|")).toBe("new bytes([uint256 length])");
    expect(await shown("string memory s = new string(|")).toBe("new string([uint256 length])");
    expect(await shown("uint256[] memory a = new uint256[](|")).toBe("new uint256[]([uint256 length])");
    const udvt = `pragma solidity ^0.8.20;
type Price is uint128;
contract C {
    function f(function(uint256, address) view returns (bool) check, Price p) external view {
        BODY
    }
    function g(uint256 x) internal pure returns (bytes32) {}
    modifier only(bytes32 role) { _; }
    function h(uint256 x) external only(g(|)) {}
}
`;
    const at = async (body: string, marker = "|") => {
      const source = udvt.replace("BODY", body);
      const text = source.replace(marker, "");
      const h = await signatureHelpAt(parseStructure(text), source.indexOf(marker), { version: "0.8.30", path: "/p/C.sol", host: memoryHost({ "/p/C.sol": text }) });
      return h?.signatures[h.activeSignature]?.label;
    };
    expect(await at("Price.wrap(|")).toBe("Price.wrap(uint128 value) returns (Price)");
    expect(await at("Price.unwrap(|")).toBe("Price.unwrap(Price value) returns (uint128)");
    expect(await at("check(1, |")).toBe("check(uint256, address) returns (bool)");
    expect(await at("")).toBe("function g(uint256 x) returns (bytes32)");
  });

  it("goes to the enclosing call from conversions, parentheses and indexes", async () => {
    expect(await shown("token.transfer(address(|")).toBe("function transfer([address to], uint256 value) returns (bool)");
    expect(await shown("token.transfer(who, (n + |")).toBe("function transfer(address to, [uint256 value]) returns (bool)");
    expect(await shown("put(IERC20(|")).toBe("function put([address to], uint256 amount)");
  });

  it("says nothing outside calls, in declarations, comments and strings", async () => {
    expect(await help("uint256 x = |")).toBeUndefined();
    expect(await help("// token.transfer(|")).toBeUndefined();
    expect(await help('string memory s = "token.transfer(|";')).toBeUndefined();
    expect(await help("if (|")).toBeUndefined();
    expect(await help("unknown(|")).toBeUndefined();
    const decl = `pragma solidity ^0.8.20;\ncontract C {\n    function g(uint256 a, |) external {}\n}\n`;
    expect(await signatureHelpAt(parseStructure(decl.replace("|", "")), decl.indexOf("|"), { version: "0.8.30" })).toBeUndefined();
    expect(await help("token.transfer(who, n);|")).toBeUndefined();
  });
});
