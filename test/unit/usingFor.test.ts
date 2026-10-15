import { describe, expect, it } from "vitest";
import { parseStructure } from "../../src/core/completion/structure";
import { hoverAt } from "../../src/core/hover/hover";
import { memberDefinition } from "../../src/core/navigation/memberDefinition";
import { entriesIn, memoryHost } from "./completionHelpers";

const LIBS = {
  "/p/IERC20.sol": `pragma solidity ^0.8.20;
interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
}
`,
  "/p/SafeERC20.sol": `pragma solidity ^0.8.20;
import {IERC20} from "./IERC20.sol";
library SafeERC20 {
    function safeTransfer(IERC20 token, address to, uint256 value) internal {}
    function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {}
    function _callOptionalReturn(IERC20 token, bytes memory data) private {}
}
`,
  "/p/Math.sol": `pragma solidity ^0.8.20;
library Math {
    function max(uint256 a, uint256 b) internal pure returns (uint256) {}
    function mulDiv(uint256 x, uint256 y, uint256 denominator) internal pure returns (uint256) {}
    function mulDiv(uint256 x, uint256 y, uint256 denominator, bool roundUp) internal pure returns (uint256) {}
}
library SafeCast {
    function toUint128(uint256 value) internal pure returns (uint128) {}
    function toInt256(uint256 value) internal pure returns (int256) {}
    function toUint256(int256 value) internal pure returns (uint256) {}
    function toUint(bool b) internal pure returns (uint256) {}
}
library Addr {
    function isContract(address account) internal view returns (bool) {}
}
`,
  "/p/Fixed.sol": `pragma solidity ^0.8.20;
type Fixed is int256;
using {add as +, toInt, FixedLib.mul} for Fixed global;
function add(Fixed a, Fixed b) pure returns (Fixed) {}
function toInt(Fixed a) pure returns (int256) {}
library FixedLib {
    function mul(Fixed a, Fixed b) internal pure returns (Fixed) {}
    function unused(Fixed a) internal pure {}
}
`,
};

const VAULT = (members: string, body: string, fileLevel = "") => `pragma solidity ^0.8.20;
import {IERC20} from "./IERC20.sol";
import {SafeERC20} from "./SafeERC20.sol";
import {Math, SafeCast, Addr} from "./Math.sol";
import {Fixed} from "./Fixed.sol";
${fileLevel}
contract Vault {
    ${members}
    IERC20 token;
    function f(uint256 amount, address to, Fixed price, int256 delta) external {
        ${body}
    }
}
`;

const files = (members: string, body: string, fileLevel = "") => ({ ...LIBS, "/p/Vault.sol": VAULT(members, body, fileLevel) });

async function labels(members: string, body: string, fileLevel = ""): Promise<string[]> {
  return (await entriesIn(files(members, body, fileLevel), "/p/Vault.sol")).map((e) => e.label);
}

describe("using ... for directives", () => {
  it("are recorded per contract and at file level", () => {
    const s = parseStructure(`pragma solidity ^0.8.20;
using {add as +, L.sub, f} for T global;
using L for *;
contract C {
    using SafeERC20 for IERC20;
    using Math for uint256[];
    using broken
    function g() external {}
}
`);
    expect(s.usings).toEqual([
      { functions: ["L.sub", "f"], target: "T", global: true, start: expect.any(Number) },
      { library: "L", target: "*", global: false, start: expect.any(Number) },
    ]);
    expect(s.contracts[0]!.usings.map((u) => `${u.library}:${u.target}`)).toEqual(["SafeERC20:IERC20", "Math:uint256[]"]);
    expect(s.contracts[0]!.members.map((m) => m.name)).toEqual(["g"]);
  });
});

describe("completion of attached functions", () => {
  it("suggests library functions after a value, without private ones", async () => {
    const list = await labels("using SafeERC20 for IERC20;", "token.|");
    expect(list).toContain("transfer");
    expect(list).toContain("safeTransfer");
    expect(list).toContain("safeTransferFrom");
    expect(list).not.toContain("_callOptionalReturn");
  });

  it("leaves out the first parameter, which the value fills", async () => {
    const entries = await entriesIn(files("using SafeERC20 for IERC20;", "token.|"), "/p/Vault.sol");
    const e = entries.find((x) => x.label === "safeTransfer")!;
    expect(e.detail).toBe("safeTransfer(address to, uint256 value)");
    expect(e.kind).toBe("method");
    expect(e.documentation).toContain("SafeERC20");
  });

  it("keeps only functions whose first parameter takes the value", async () => {
    const list = await labels("using SafeCast for uint256;", "amount.|");
    expect(list).toContain("toUint128");
    expect(list).toContain("toInt256");
    expect(list).not.toContain("toUint256");
    expect(list).not.toContain("toUint");
    // `using L for *`: every type, still filtered by the first parameter.
    const any = await labels("using SafeCast for *;", "delta.|");
    expect(any).toContain("toUint256");
    expect(any).not.toContain("toUint128");
  });

  it("applies directives of the file and of the enclosing contract only", async () => {
    expect(await labels("", "to.|", "using Addr for address;")).toContain("isContract");
    expect(await labels("", "to.|")).not.toContain("isContract");
    const derived = `pragma solidity ^0.8.20;
import {Addr} from "./Math.sol";
contract Base { using Addr for address; }
contract Child is Base {
    function f(address a) external { a.| }
}
`;
    const list = (await entriesIn({ ...LIBS, "/p/Child.sol": derived }, "/p/Child.sol")).map((e) => e.label);
    expect(list).not.toContain("isContract");
  });

  it("uses global directives of the file declaring the type, without functions bound to operators", async () => {
    const list = await labels("", "price.|");
    expect(list).toContain("toInt");
    expect(list).toContain("mul");
    expect(list).not.toContain("add");
    expect(list).not.toContain("unused");
  });

  it("types calls of attached functions, for chains and expected arguments", async () => {
    expect(await labels("using Math for uint256; using SafeCast for uint256;", "amount.max(1).|")).toContain("toUint128");
    const entries = await entriesIn(files("using Math for uint256;", "amount.max(|);"), "/p/Vault.sol");
    // The first argument is `b` (uint256): the uint256 parameter `amount` ranks as compatible.
    expect(entries.find((e) => e.label === "amount")!.rank).toBeLessThan(entries.find((e) => e.label === "to")!.rank);
  });
});

describe("hover and definition of attached functions", () => {
  async function definition(members: string, body: string): Promise<string> {
    const text = VAULT(members, body.replace("|", ""));
    const offset = VAULT(members, body).indexOf("|");
    const target = await memberDefinition(parseStructure(text), offset, "/p/Vault.sol", memoryHost({ ...LIBS, "/p/Vault.sol": text }));
    return target ? `${target.path}:${target.text.slice(0, target.nameStart).split("\n").length}` : "(none)";
  }

  async function hover(members: string, body: string): Promise<string> {
    const text = VAULT(members, body.replace("|", ""));
    const offset = VAULT(members, body).indexOf("|");
    const h = await hoverAt(parseStructure(text), offset, { version: "0.8.30", path: "/p/Vault.sol", host: memoryHost({ ...LIBS, "/p/Vault.sol": text }) });
    return h ? h.sections.map((s) => s.code).join("\n") : "(none)";
  }

  it("goes to the library function without solc", async () => {
    expect(await definition("using SafeERC20 for IERC20;", "token.safeTr|ansfer(to, amount);")).toBe("/p/SafeERC20.sol:4");
    expect(await definition("", "price.m|ul(price);")).toBe("/p/Fixed.sol:7");
  });

  it("hovers the overload taking as many arguments as the call, the value not counted", async () => {
    expect(await hover("using Math for uint256;", "amount.mul|Div(2, 3);")).toBe(
      "function mulDiv(uint256 x, uint256 y, uint256 denominator) internal pure returns (uint256)",
    );
    expect(await hover("using Math for uint256;", "amount.mul|Div(2, 3, true);")).toContain("bool roundUp");
  });
});

describe("user-defined value types", () => {
  it("types wrap and unwrap, so attached functions chain after them", async () => {
    expect(await labels("", "Fixed.wrap(delta).|")).toContain("toInt");
    expect(await labels("using SafeCast for int256;", "Fixed.unwrap(price).|")).toContain("toUint256");
  });
});
