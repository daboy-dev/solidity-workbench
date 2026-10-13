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
