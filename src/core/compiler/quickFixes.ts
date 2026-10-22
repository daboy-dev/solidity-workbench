/** Quick fixes for solc diagnostics, computed on the source text. */

const LOCATIONS = ["memory", "calldata", "storage"] as const;
export type DataLocation = (typeof LOCATIONS)[number];

export interface DataLocationFix {
  /** Offset where ` <location>` is inserted (after the type). */
  readonly offset: number;
  /** Allowed locations, the preferred one first, then in solc's order. */
  readonly locations: readonly DataLocation[];
}

/**
 * Fix for solc 6651 ("Data location must be "memory" or "calldata" for parameter in
 * external function, but none was given."), reported on a declaration such as
 * `string s` or `Listing listing`: insert one of the allowed locations before the
 * name. `calldata` is preferred for external function parameters, `memory` elsewhere.
 */
export function dataLocationFix(text: string, start: number, end: number, message: string): DataLocationFix | undefined {
  // In the order solc lists them.
  const allowed = LOCATIONS.filter((l) => message.includes(`"${l}"`)).sort((a, b) => message.indexOf(`"${a}"`) - message.indexOf(`"${b}"`));
  if (allowed.length === 0) return undefined;
  const preferred: DataLocation = /external function/.test(message) && allowed.includes("calldata") ? "calldata" : allowed.includes("memory") ? "memory" : allowed[0]!;
  const declaration = text.slice(start, end);
  // `Type name` → before the name; a nameless parameter (`string`) → at the end.
  const named = /^([\s\S]*?[\w$\])])\s+([A-Za-z_$][\w$]*)\s*$/.exec(declaration);
  // In `address payable`, `payable` belongs to the type.
  const typeEnd = named && named[2] !== "payable" ? named[1]!.length : declaration.trimEnd().length;
  const offset = start + typeEnd;
  return { offset, locations: [preferred, ...allowed.filter((l) => l !== preferred)] };
}

export interface ChecksumFix {
  readonly start: number;
  readonly end: number;
  /** The literal with the EIP-55 checksum solc suggests. */
  readonly address: string;
}

/**
 * Fix for solc 9429 ("This looks like an address but has an invalid checksum. Correct
 * checksummed address: "0x…"."), reported on the literal: replace it with the address
 * solc suggests, if it is the same address. Other 9429 messages (wrong number of hex
 * digits) have no fix.
 */
export function checksumAddressFix(text: string, start: number, end: number, message: string): ChecksumFix | undefined {
  const address = /Correct checksummed address: "(0x[0-9a-fA-F]{40})"/.exec(message)?.[1];
  if (!address) return undefined;
  // The range is the literal; search it in case solc widens it.
  const re = /0x[0-9a-fA-F]{40}(?![\w$])/g;
  for (let m; (m = re.exec(text.slice(start, end))); ) {
    if (m[0].toLowerCase() === address.toLowerCase()) return { start: start + m.index, end: start + m.index + m[0].length, address };
  }
  return undefined;
}
