import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { complete } from "../../src/core/completion/complete";
import { cursorContext } from "../../src/core/completion/cursorContext";
import { languageVersion } from "../../src/core/completion/languageVersion";
import { parseStructure } from "../../src/core/completion/structure";
import { entries, inBody, labels } from "./completionHelpers";

describe("global completions", () => {
  it("suggests the members of msg, tx and abi", async () => {
    expect(await labels(inBody("msg.|"))).toEqual(["data", "sender", "sig", "value"]);
    expect(await labels(inBody("address s = msg.se|"))).toContain("sender");
    expect(await labels(inBody("tx.|"))).toEqual(["gasprice", "origin"]);
    expect(await labels(inBody("abi.|"), { version: "0.8.10" })).not.toContain("encodeCall");
    expect(await labels(inBody("abi.|"), { version: "0.8.11" })).toContain("encodeCall");
  });

  it("follows the solc version for block members", async () => {
    const old = await entries(inBody("block.|"), { version: "0.8.17" });
    expect(old.map((e) => e.label)).not.toContain("prevrandao");
    expect(old.map((e) => e.label)).not.toContain("blobbasefee");
    expect(old.find((e) => e.label === "difficulty")?.deprecated).toBeUndefined();

    const recent = await entries(inBody("block.|"), { version: "0.8.24" });
    expect(recent.map((e) => e.label)).toEqual(expect.arrayContaining(["prevrandao", "blobbasefee", "timestamp", "chainid", "basefee"]));
    expect(recent.find((e) => e.label === "difficulty")?.deprecated).toBe(true);
  });

  it("suggests address members, transfer and send only on payable addresses", async () => {
    expect(await labels(inBody("address(this).|"))).toEqual(["balance", "code", "codehash", "call", "delegatecall", "staticcall"]);
    expect(await labels(inBody("msg.sender.|"))).not.toContain("transfer");
    expect(await labels(inBody("payable(msg.sender).|"))).toEqual(expect.arrayContaining(["balance", "call", "transfer", "send"]));
    expect(await labels(inBody("block.coinbase.|"))).toContain("send");
  });

  it("marks transfer and send as deprecated from 0.8.31", async () => {
    const before = await entries(inBody("payable(a).|"), { version: "0.8.30" });
    expect(before.find((e) => e.label === "transfer")?.deprecated).toBeUndefined();
    const after = await entries(inBody("payable(a).|"), { version: "0.8.31" });
    const transfer = after.find((e) => e.label === "transfer")!;
    expect(transfer.deprecated).toBe(true);
    expect(transfer.documentation).toContain("0.8.31");
    expect(after.find((e) => e.label === "send")?.deprecated).toBe(true);
  });

  it("suggests type(X) members", async () => {
    expect(await labels(inBody("type(uint8).|"))).toEqual(["min", "max"]);
    expect((await entries(inBody("type(int).|"))).map((e) => e.detail)).toEqual(["int256", "int256"]);
    expect(await labels(inBody("type(IERC20).|"))).toEqual(expect.arrayContaining(["interfaceId", "creationCode", "name"]));
  });

  it("suggests bytes.concat and string.concat by version", async () => {
    expect(await labels(inBody("bytes.|"))).toEqual(["concat"]);
    expect(await labels(inBody("string.|"), { version: "0.8.11" })).toEqual([]);
    expect(await labels(inBody("string.|"), { version: "0.8.12" })).toEqual(["concat"]);
  });

  it("suggests global functions and namespaces in expressions", async () => {
    const found = await labels(inBody("bytes32 h = |"), { version: "0.8.20" });
    expect(found).toEqual(expect.arrayContaining(["msg", "block", "tx", "abi", "this", "keccak256", "sha256", "ecrecover", "addmod", "mulmod", "gasleft", "blockhash"]));
    expect(found).not.toContain("blobhash");
    expect(await labels(inBody("bytes32 h = |"), { version: "0.8.24" })).toContain("blobhash");
    expect(await labels(inBody("|"))).toEqual(expect.arrayContaining(["require", "assert", "revert"]));
    const detail = (await entries(inBody("bytes32 h = |"))).find((e) => e.label === "keccak256")?.detail;
    expect(detail).toBe("keccak256(bytes memory) returns (bytes32)");
  });

  it("suggests units after a number literal", async () => {
    expect(await labels(inBody("uint256 x = 1 |"))).toEqual(["wei", "gwei", "ether", "seconds", "minutes", "hours", "days", "weeks"]);
  });

  it("suggests nothing in comments and strings", async () => {
    expect(await labels(inBody("// msg.|"))).toEqual([]);
    expect(await labels(inBody('string memory s = "|";'))).toEqual([]);
  });
});

describe("language version", () => {
  const installed = (...versions: string[]) => versions.map((version) => ({ version, path: `/svm/${version}/solc-${version}` }));

  it("uses the installed solc that compiler diagnostics would choose", () => {
    expect(languageVersion(installed("0.8.30", "0.8.19"), ["^0.8.20"], undefined)).toBe("0.8.30");
    expect(languageVersion(installed("0.8.30", "0.8.19"), [">=0.8.0 <0.8.20"], undefined)).toBe("0.8.19");
  });

  it("uses the configured version, else the newest release allowed by the pragmas", () => {
    expect(languageVersion(installed("0.8.30"), ["^0.8.0"], "0.8.24")).toBe("0.8.24");
    expect(languageVersion([], [">=0.8.0 <0.8.18"], undefined)).toBe("0.8.17");
    expect(languageVersion([], ["0.8.13"], undefined)).toBe("0.8.13");
    // A configured binary path says nothing about the version: the pragmas decide.
    expect(languageVersion(installed("0.8.30"), ["0.8.21"], "/opt/solc")).toBe("0.8.21");
  });

  it("treats older pragmas as 0.8.0", () => {
    expect(languageVersion([], ["^0.7.6"], undefined)).toBe("0.8.0");
    expect(languageVersion(installed("0.6.12"), ["^0.6.0"], undefined)).toBe("0.8.0");
  });
});

describe("robustness", () => {
  it("never throws on truncated or edited real sources", async () => {
    const root = path.join(__dirname, "../fixtures/foundry-project");
    const files = fs.readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".sol"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      const step = Math.max(1, Math.floor(text.length / 150));
      for (let cut = 0; cut <= text.length; cut += step) {
        // The file as if typed up to `cut`, and with the rest of the line deleted.
        for (const variant of [text.slice(0, cut), text.slice(0, cut) + text.slice(text.indexOf("\n", cut) >>> 0)]) {
          const structure = parseStructure(variant);
          await complete(cursorContext(structure, Math.min(cut, variant.length)), { version: "0.8.30" });
        }
      }
    }
  });
});
