import {
  ABI,
  ADDRESS,
  ADDRESS_PAYABLE,
  BLOCK,
  BYTES_STATIC,
  DYNAMIC_ARRAY,
  FIXED_BYTES,
  GLOBAL_FUNCTIONS,
  INTEGER_TYPE_INFO,
  MSG,
  STATIC_ARRAY,
  STRING_STATIC,
  TX,
  type Builtin,
} from "./builtins";
import type { Expr } from "./cursorContext";
import type { Sym, TypeScope } from "./symbols";

const SIZES = Array.from({ length: 32 }, (_, i) => (i + 1) * 8);

/** Elementary type names, in the order they are suggested. */
export const ELEMENTARY_TYPES: readonly string[] = [
  "address",
  "bool",
  "string",
  "bytes",
  ...Array.from({ length: 32 }, (_, i) => `bytes${i + 1}`),
  ...SIZES.map((s) => `uint${s}`),
  ...SIZES.map((s) => `int${s}`),
  "uint",
  "int",
];

const ELEMENTARY = new Set(ELEMENTARY_TYPES);

export function isElementaryType(name: string): boolean {
  return ELEMENTARY.has(name) || name === "address payable";
}

export function isIntegerType(name: string): boolean {
  return /^u?int(\d+)?$/.test(name) && ELEMENTARY.has(name);
}

/** Types stored by reference, which need a data location in parameters and local variables. */
export function isReferenceType(type: string): boolean {
  if (type.endsWith("]") || type === "string" || type === "bytes" || type.startsWith("mapping(")) return true;
  return !isElementaryType(type) && !type.startsWith("function");
}

/** `uint` is `uint256`, `int` is `int256`. */
export function canonicalType(type: string): string {
  if (type === "uint") return "uint256";
  if (type === "int") return "int256";
  return type;
}

/** What an expression is, as far as completion is concerned. */
export type ExprType =
  /**
   * A value of a Solidity type, written as in source (`uint256`, `address payable`, `Listing`, `IERC20`),
   * with where it was written, to resolve user-defined names.
   */
  | { readonly kind: "value"; readonly type: string; readonly at?: TypeScope }
  | { readonly kind: "namespace"; readonly name: "msg" | "block" | "tx" | "abi" }
  /** `type(X)`. */
  | { readonly kind: "typeInfo"; readonly of: string; readonly at?: TypeScope }
  /** A type or unit alias used as an expression: `bytes.concat`, `Lib.f`, `Color.Red`, `Alias.Token`. */
  | { readonly kind: "static"; readonly type: string; readonly sym?: Sym }
  /** A function used as a value (`this.f.selector`), or called (its returns). */
  | { readonly kind: "function"; readonly sym: Sym; readonly external: boolean }
  | { readonly kind: "this" }
  | { readonly kind: "super" };

const NAMESPACES: Readonly<Record<string, readonly Builtin[]>> = { msg: MSG, block: BLOCK, tx: TX, abi: ABI };

/**
 * Types an expression using only built-in knowledge. `lookupName` gives the
 * type of other names (variables, contracts...), when known.
 */
export function builtinTypeOf(expr: Expr, lookupName: (name: string) => ExprType | undefined = () => undefined): ExprType | undefined {
  switch (expr.kind) {
    case "name":
      if (expr.name === "msg" || expr.name === "block" || expr.name === "tx" || expr.name === "abi") return { kind: "namespace", name: expr.name };
      if (expr.name === "this") return { kind: "this" };
      if (expr.name === "super") return { kind: "super" };
      if (isElementaryType(expr.name)) return { kind: "static", type: expr.name };
      return lookupName(expr.name);
    case "member": {
      const object = builtinTypeOf(expr.object, lookupName);
      if (object?.kind === "namespace") {
        const member = NAMESPACES[object.name]!.find((b) => b.name === expr.name);
        return member?.kind === "property" ? { kind: "value", type: member.type } : undefined;
      }
      if (object?.kind === "value") {
        const member = valueMembers(object.type).find((b) => b.name === expr.name);
        return member?.kind === "property" && member.type ? { kind: "value", type: member.type } : undefined;
      }
      return undefined;
    }
    case "call": {
      const callee = expr.callee;
      if (callee.kind === "name") {
        if (callee.name === "payable") return { kind: "value", type: "address payable" };
        if (isElementaryType(callee.name)) return { kind: "value", type: callee.name };
        const global = GLOBAL_FUNCTIONS.find((b) => b.name === callee.name);
        if (global) return global.type ? { kind: "value", type: global.type } : undefined;
        // A conversion to a contract or interface type: `IERC20(token)`.
        const named = lookupName(callee.name);
        return named?.kind === "static" ? { kind: "value", type: named.type } : undefined;
      }
      if (callee.kind === "member") {
        const object = builtinTypeOf(callee.object, lookupName);
        const list = object?.kind === "namespace" ? NAMESPACES[object.name]! : object?.kind === "static" ? staticMembers(object.type) : [];
        const member = list.find((b) => b.name === callee.name && b.kind === "function");
        return member?.type ? { kind: "value", type: member.type } : undefined;
      }
      if (callee.kind === "new") return { kind: "value", type: callee.type };
      return undefined;
    }
    case "typeOf":
      return { kind: "typeInfo", of: expr.type };
    case "index": {
      const object = builtinTypeOf(expr.object, lookupName);
      if (object?.kind !== "value") return undefined;
      const element = indexedType(object.type);
      return element ? { kind: "value", type: element } : undefined;
    }
    case "new":
      return { kind: "value", type: expr.type };
    case "literal":
      return { kind: "value", type: expr.type === "number" ? "uint256" : expr.type };
  }
}

/** Members of a value of an elementary, array or address type. */
export function valueMembers(type: string): readonly Builtin[] {
  if (type === "address") return ADDRESS;
  if (type === "address payable") return [...ADDRESS, ...ADDRESS_PAYABLE];
  if (/\[\]$/.test(type) || type === "bytes") return DYNAMIC_ARRAY;
  if (/\[[^\]]+\]$/.test(type)) return STATIC_ARRAY;
  if (/^bytes\d+$/.test(type)) return FIXED_BYTES;
  return [];
}

/** Members of an elementary type used as an expression (`bytes.concat`). */
export function staticMembers(type: string): readonly Builtin[] {
  if (type === "bytes") return BYTES_STATIC;
  if (type === "string") return STRING_STATIC;
  return [];
}

/** Members of `type(X)` for an elementary X; contracts, interfaces and enums need a lookup. */
export function elementaryTypeInfo(of: string): readonly Builtin[] | undefined {
  return isIntegerType(of) ? INTEGER_TYPE_INFO.map((b) => ({ ...b, type: canonicalType(of) })) : undefined;
}

/** Type of `x[i]` for a value of type `type`. */
export function indexedType(type: string): string | undefined {
  const array = /^(.*)\[[^\]]*\]$/.exec(type);
  if (array) return array[1]!;
  if (type.startsWith("mapping(")) return mappingValue(type);
  if (type === "bytes" || /^bytes\d+$/.test(type)) return "bytes1";
  return undefined;
}

/** `mapping(K => V)` → `V` (V may itself be a mapping). */
export function mappingValue(type: string): string | undefined {
  const inner = type.slice("mapping(".length, -1);
  let depth = 0;
  for (let i = 0; i < inner.length - 1; i++) {
    const c = inner[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && c === "=" && inner[i + 1] === ">") {
      // Named mapping keys and values (`mapping(address owner => uint256 amount)`) drop the names.
      return stripName(inner.slice(i + 2).trim());
    }
  }
  return undefined;
}

function stripName(type: string): string {
  if (type.startsWith("mapping(")) return type;
  const parts = type.split(" ");
  if (parts.length === 2 && parts[1] !== "payable") return parts[0]!;
  if (parts.length === 3 && parts[1] === "payable") return `${parts[0]} payable`;
  return type;
}
