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

