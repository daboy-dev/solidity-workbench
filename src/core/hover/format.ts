import { isAvailable, isDeprecated, type Builtin } from "../completion/builtins";
import type { HoverSection } from "./hover";

/**
 * A built-in global or member as a hover: `address msg.sender`,
 * `function keccak256(bytes memory) returns (bytes32)`, with its documentation and
 * what the file's solc version says about it (deprecated, or not there yet).
 */
export function builtinSection(b: Builtin, version: string, owner?: string): HoverSection {
  const name = owner ? `${owner}.${b.name}` : b.name;
  const code = b.kind === "function" ? `function ${name}${b.signature ?? "()"}` : b.type ? `${b.type} ${name}` : name;
  const notes = [b.doc];
  if (!isAvailable(b, version)) notes.push(`**Not available in solc ${version}: added in ${b.since}.**`);
  else if (isDeprecated(b, version) && b.deprecation) notes.push(`**${b.deprecation}**`);
  return { code, doc: notes.join("\n\n") };
}

const ETHER_UNITS = new Set(["wei", "gwei", "ether"]);

/** `1 ether`, `2 days`. */
export function unitSection(unit: Builtin): HoverSection {
  const ether = ETHER_UNITS.has(unit.name);
  const value = unit.doc === "1" ? (ether ? "the base unit" : "the base unit, in seconds") : unit.doc;
  return { code: `1 ${unit.name}`, doc: `${ether ? "Ether" : "Time"} unit: \`1 ${unit.name}\` is ${value}.` };
}


/** An elementary type: its range or size, and what it offers. */
export function elementaryTypeSection(type: string): HoverSection | undefined {
  const int = /^(u?)int(\d*)$/.exec(type);
  if (int) {
    const bits = Number(int[2] || 256);
    const signed = int[1] === "";
    const alias = int[2] ? "" : ` Alias of \`${type}256\`.`;
    const range = signed ? `${bound(-1n, bits - 1, 0n)} to ${bound(1n, bits - 1, -1n)}` : `0 to ${bound(1n, bits, -1n)}`;
    return { code: type, doc: `${signed ? "Signed" : "Unsigned"} integer of ${bits} bits: ${range}.${alias} Members of \`type(${type})\`: \`min\`, \`max\`.` };
  }
  const fixed = /^bytes(\d+)$/.exec(type);
  if (fixed) return { code: type, doc: `Fixed-size byte array of ${fixed[1]} byte${fixed[1] === "1" ? "" : "s"}. Members: \`length\`.` };
  const doc = ELEMENTARY_DOCS[type];
  return doc ? { code: type, doc } : undefined;
}

/** `sign * 2**exp + offset`, in digits when short, else as a power of two. */
function bound(sign: bigint, exp: number, offset: bigint): string {
  if (exp <= 64) return String(sign * 2n ** BigInt(exp) + offset);
  const power = `2**${exp}`;
  return `${sign < 0n ? "-" : ""}${power}${offset < 0n ? " - 1" : ""}`;
}

const ELEMENTARY_DOCS: Readonly<Record<string, string>> = {
  address: "20-byte Ethereum address. Members: `balance`, `code`, `codehash`, `call`, `delegatecall`, `staticcall`.",
  "address payable": "Address that can receive Ether. Members of `address`, plus `transfer` and `send`.",
  bool: "`true` or `false`.",
  string: "Dynamically-sized UTF-8 string. `string.concat(...)` joins strings; use `bytes(s).length` for its size in bytes.",
  bytes: "Dynamically-sized byte array. Members: `length`, `push`, `pop`; `bytes.concat(...)` joins byte arrays.",
};
