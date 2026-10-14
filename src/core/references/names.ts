/** Checks of new names for Rename Symbol. */

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Keywords and words reserved for future use. Contextual keywords (`global`, `layout`, `at`) are valid names; `error` and `transient` are refused because the tolerant parser reads them as keywords. */
const RESERVED = new Set([
  "abstract", "after", "alias", "anonymous", "apply", "as", "assembly", "auto", "break", "byte", "calldata", "case",
  "catch", "constant", "constructor", "continue", "contract", "copyof", "default", "define", "delete", "do", "else", "emit",
  "enum", "error", "event", "external", "fallback", "false", "final", "for", "function", "if", "immutable",
  "implements", "import", "in", "indexed", "inline", "interface", "internal", "is", "let", "library", "macro",
  "mapping", "match", "memory", "modifier", "mutable", "new", "null", "of", "override", "partial", "payable", "pragma",
  "private", "promise", "public", "pure", "receive", "reference", "relocatable", "return", "returns", "sealed", "sizeof",
  "static", "storage", "struct", "supports", "switch", "transient", "true", "try", "type", "typedef", "typeof", "unchecked",
  "using", "var", "view", "virtual", "while",
  // Units.
  "wei", "gwei", "ether", "seconds", "minutes", "hours", "days", "weeks", "years",
]);

/** Global variables and functions: shadowing them is legal but breaks any use of the builtin in scope. */
const GLOBALS = new Set([
  "this", "super", "msg", "block", "tx", "abi", "now", "gasleft", "blockhash", "blobhash", "keccak256", "sha256", "ripemd160",
  "ecrecover", "addmod", "mulmod", "selfdestruct", "require", "assert", "revert", "bytes", "string", "address", "bool",
]);

function isElementaryType(name: string): boolean {
  const int = /^u?int(\d*)$/.exec(name);
  if (int) return int[1] === "" || (Number(int[1]) % 8 === 0 && Number(int[1]) >= 8 && Number(int[1]) <= 256);
  const bytes = /^bytes(\d+)$/.exec(name);
  if (bytes) return Number(bytes[1]) >= 1 && Number(bytes[1]) <= 32;
  return /^u?fixed(\d+x\d+)?$/.test(name);
}

/** Why `name` cannot be used as a new name, or undefined when it can. */
export function invalidNameReason(name: string): string | undefined {
  if (!IDENTIFIER.test(name)) return `\`${name}\` is not a valid Solidity identifier.`;
  if (RESERVED.has(name)) return `\`${name}\` is a reserved word in Solidity.`;
  if (isElementaryType(name)) return `\`${name}\` is the name of a Solidity type.`;
  if (GLOBALS.has(name)) return `\`${name}\` is a global name in Solidity; renaming to it would shadow the builtin.`;
  if (name === "_") return "`_` is reserved for the modifier placeholder.";
  return undefined;
}
