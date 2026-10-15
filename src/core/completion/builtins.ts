import semver from "semver";

/**
 * Global variables, functions and members of built-in types, as documented
 * for Solidity 0.8 ("Units and Globally Available Variables", "Types").
 */
export interface Builtin {
  readonly name: string;
  readonly kind: "property" | "function";
  /** Type of the value, or what a function returns (empty when nothing). */
  readonly type: string;
  /** Parameters and returns, for functions: `(bytes memory) returns (bytes32)`. */
  readonly signature?: string;
  readonly doc: string;
  /** First solc version that has it. */
  readonly since?: string;
  readonly deprecatedSince?: string;
  readonly deprecation?: string;
}

const prop = (name: string, type: string, doc: string, extra: Partial<Builtin> = {}): Builtin => ({ name, kind: "property", type, doc, ...extra });
const fn = (name: string, signature: string, type: string, doc: string, extra: Partial<Builtin> = {}): Builtin => ({
  name,
  kind: "function",
  type,
  signature,
  doc,
  ...extra,
});

export const MSG: readonly Builtin[] = [
  prop("data", "bytes", "Complete calldata."),
  prop("sender", "address", "Sender of the message (current call)."),
  prop("sig", "bytes4", "First four bytes of the calldata (function identifier)."),
  prop("value", "uint256", "Number of wei sent with the message."),
];

export const BLOCK: readonly Builtin[] = [
  prop("basefee", "uint256", "Current block's base fee (EIP-3198 and EIP-1559).", { since: "0.8.7" }),
  prop("blobbasefee", "uint256", "Current block's blob base fee (EIP-7516 and EIP-4844).", { since: "0.8.24" }),
  prop("chainid", "uint256", "Current chain id."),
  prop("coinbase", "address payable", "Current block miner's address."),
  prop("difficulty", "uint256", "Current block difficulty. Since Paris it is an alias for `block.prevrandao`.", {
    deprecatedSince: "0.8.18",
    deprecation: "Deprecated since 0.8.18: use `block.prevrandao`.",
  }),
  prop("gaslimit", "uint256", "Current block gas limit."),
  prop("number", "uint256", "Current block number."),
  prop("prevrandao", "uint256", "Random number provided by the beacon chain (EIP-4399).", { since: "0.8.18" }),
  prop("timestamp", "uint256", "Current block timestamp as seconds since unix epoch."),
];

export const TX: readonly Builtin[] = [
  prop("gasprice", "uint256", "Gas price of the transaction."),
  prop("origin", "address", "Sender of the transaction (full call chain)."),
];

export const ABI: readonly Builtin[] = [
  fn("decode", "(bytes memory encodedData, (...)) returns (...)", "", "ABI-decodes the given data; the types are given in parentheses as second argument."),
  fn("encode", "(...) returns (bytes memory)", "bytes", "ABI-encodes the given arguments."),
  fn("encodePacked", "(...) returns (bytes memory)", "bytes", "Performs packed encoding of the given arguments. Packed encoding can be ambiguous."),
  fn("encodeWithSelector", "(bytes4 selector, ...) returns (bytes memory)", "bytes", "ABI-encodes the given arguments starting from the second and prepends the given four-byte selector."),
  fn("encodeWithSignature", "(string memory signature, ...) returns (bytes memory)", "bytes", "Equivalent to `abi.encodeWithSelector(bytes4(keccak256(bytes(signature))), ...)`."),
  fn("encodeCall", "(function functionPointer, (...)) returns (bytes memory)", "bytes", "ABI-encodes a call to `functionPointer` with the arguments found in the tuple, with full type checking.", {
    since: "0.8.11",
  }),
];

/** Members of `address`. */
export const ADDRESS: readonly Builtin[] = [
  prop("balance", "uint256", "Balance of the address in wei."),
  prop("code", "bytes", "Code at the address (can be empty)."),
  prop("codehash", "bytes32", "The code hash of the address."),
  fn("call", "(bytes memory) returns (bool, bytes memory)", "", "Issues a low-level `CALL` with the given payload; returns success condition and return data. Forwards all available gas, adjustable."),
  fn("delegatecall", "(bytes memory) returns (bool, bytes memory)", "", "Issues a low-level `DELEGATECALL` with the given payload; returns success condition and return data."),
  fn("staticcall", "(bytes memory) returns (bool, bytes memory)", "", "Issues a low-level `STATICCALL` with the given payload; returns success condition and return data."),
];

const SEND_DEPRECATION = 'Deprecated since 0.8.31: use `call{value: amount}("")` and check the result.';

/** Additional members of `address payable`. */
export const ADDRESS_PAYABLE: readonly Builtin[] = [
  fn("transfer", "(uint256 amount)", "", "Sends the given amount of wei to the address, reverts on failure, forwards 2300 gas stipend.", {
    deprecatedSince: "0.8.31",
    deprecation: SEND_DEPRECATION,
  }),
  fn("send", "(uint256 amount) returns (bool)", "bool", "Sends the given amount of wei to the address, returns `false` on failure, forwards 2300 gas stipend.", {
    deprecatedSince: "0.8.31",
    deprecation: SEND_DEPRECATION,
  }),
];

/** Global functions. */
export const GLOBAL_FUNCTIONS: readonly Builtin[] = [
  fn("addmod", "(uint256 x, uint256 y, uint256 k) returns (uint256)", "uint256", "Computes `(x + y) % k` with arbitrary precision; reverts if `k == 0`."),
  fn("assert", "(bool condition)", "", "Causes a Panic error and reverts if the condition is not met. For internal errors."),
  fn("blobhash", "(uint256 index) returns (bytes32)", "bytes32", "Versioned hash of the `index`-th blob of the current transaction (EIP-4844).", { since: "0.8.24" }),
  fn("blockhash", "(uint256 blockNumber) returns (bytes32)", "bytes32", "Hash of the given block, for one of the 256 most recent blocks; zero otherwise."),
  fn("ecrecover", "(bytes32 hash, uint8 v, bytes32 r, bytes32 s) returns (address)", "address", "Recovers the address associated with the public key from the elliptic curve signature; returns zero on error."),
  fn("gasleft", "() returns (uint256)", "uint256", "Remaining gas."),
  fn("keccak256", "(bytes memory) returns (bytes32)", "bytes32", "Computes the Keccak-256 hash of the input."),
  fn("mulmod", "(uint256 x, uint256 y, uint256 k) returns (uint256)", "uint256", "Computes `(x * y) % k` with arbitrary precision; reverts if `k == 0`."),
  fn("require", "(bool condition, string memory message)", "", "Reverts if the condition is not met. The second argument can be a message or, since 0.8.26, a custom error."),
  fn("revert", "(string memory reason)", "", "Aborts execution and reverts state changes, providing an explanatory string."),
  fn("ripemd160", "(bytes memory) returns (bytes20)", "bytes20", "Computes the RIPEMD-160 hash of the input."),
  fn("selfdestruct", "(address payable recipient)", "", "Sends all Ether to `recipient`. Since Cancun the contract is only destroyed when created in the same transaction.", {
    deprecatedSince: "0.8.18",
    deprecation: "Deprecated since 0.8.18 (EIP-6049).",
  }),
  fn("sha256", "(bytes memory) returns (bytes32)", "bytes32", "Computes the SHA-256 hash of the input."),
];

/** Global names that are values rather than functions. */
export const GLOBAL_VALUES: readonly Builtin[] = [
  prop("msg", "", "Properties of the current call: `sender`, `value`, `data`, `sig`."),
  prop("block", "", "Properties of the current block: `timestamp`, `number`, `chainid`..."),
  prop("tx", "", "Properties of the transaction: `origin`, `gasprice`."),
  prop("abi", "", "ABI encoding and decoding functions."),
  prop("this", "", "The current contract, explicitly convertible to `address`."),
  prop("super", "", "The contract one level higher in the inheritance hierarchy."),
];

export const INTEGER_TYPE_INFO: readonly Builtin[] = [
  prop("min", "", "The smallest value representable by the type."),
  prop("max", "", "The largest value representable by the type."),
];

export const ENUM_TYPE_INFO: readonly Builtin[] = [
  prop("min", "", "The smallest value of the enum.", { since: "0.8.8" }),
  prop("max", "", "The largest value of the enum.", { since: "0.8.8" }),
];

export const CONTRACT_TYPE_INFO: readonly Builtin[] = [
  prop("name", "string", "The name of the contract."),
  prop("creationCode", "bytes", "Memory byte array that contains the creation bytecode of the contract."),
  prop("runtimeCode", "bytes", "Memory byte array that contains the runtime bytecode of the contract."),
];

export const INTERFACE_TYPE_INFO: readonly Builtin[] = [
  prop("name", "string", "The name of the interface."),
  prop("interfaceId", "bytes4", "The EIP-165 interface identifier of the interface."),
];

export const BYTES_STATIC: readonly Builtin[] = [
  fn("concat", "(...) returns (bytes memory)", "bytes", "Concatenates a variable number of `bytes` and `bytesN` arguments into one byte array.", { since: "0.8.4" }),
];

export const STRING_STATIC: readonly Builtin[] = [
  fn("concat", "(...) returns (string memory)", "string", "Concatenates a variable number of `string` arguments into one string.", { since: "0.8.12" }),
];

export const DYNAMIC_ARRAY: readonly Builtin[] = [
  prop("length", "uint256", "Number of elements."),
  fn("push", "(value)", "", "Appends an element at the end (storage arrays and `bytes`). Without argument, appends a zero-initialised element and returns a reference to it."),
  fn("pop", "()", "", "Removes the last element (storage arrays and `bytes`)."),
];

export const STATIC_ARRAY: readonly Builtin[] = [prop("length", "uint256", "Number of elements.")];

export const FIXED_BYTES: readonly Builtin[] = [prop("length", "uint8", "Number of bytes.")];

export const EXTERNAL_FUNCTION: readonly Builtin[] = [
  prop("selector", "bytes4", "The ABI function selector."),
  prop("address", "address", "The address of the contract of the function."),
];

/** Members of an error or event used as an expression (`Errors.Unauthorized.selector`). */
export const ERROR_MEMBERS: readonly Builtin[] = [
  prop("selector", "bytes4", "The error's selector: the first four bytes of the keccak256 hash of its signature, as in its revert data.", { since: "0.8.4" }),
];

export const EVENT_MEMBERS: readonly Builtin[] = [
  prop("selector", "bytes32", "The event's selector: the keccak256 hash of its signature, the first topic of non-anonymous events.", { since: "0.8.15" }),
];

/** Built-in members of an error or event declaration, if `kind` is one. */
export function declarationMembers(kind: string): readonly Builtin[] {
  return kind === "error" ? ERROR_MEMBERS : kind === "event" ? EVENT_MEMBERS : [];
}

export const UNITS: readonly Builtin[] = [
  prop("wei", "", "1"),
  prop("gwei", "", "1e9 wei"),
  prop("ether", "", "1e18 wei"),
  prop("seconds", "", "1"),
  prop("minutes", "", "60 seconds"),
  prop("hours", "", "3600 seconds"),
  prop("days", "", "86400 seconds"),
  prop("weeks", "", "604800 seconds"),
];

/** True when the builtin exists in `version`. */
export function isAvailable(b: Builtin, version: string): boolean {
  return !b.since || semver.gte(version, b.since);
}

export function isDeprecated(b: Builtin, version: string): boolean {
  return b.deprecatedSince !== undefined && semver.gte(version, b.deprecatedSince);
}

export function availableIn(list: readonly Builtin[], version: string): Builtin[] {
  return list.filter((b) => isAvailable(b, version));
}
