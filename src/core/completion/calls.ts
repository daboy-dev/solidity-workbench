import { callArgs, type CallArgs, type Expr } from "./cursorContext";
import { declarationsNamed, memberDecls, toSym, type MemberDecl } from "./members";
import type { ContractNode, Param, SourceStructure } from "./structure";
import { isContractKind, type StructureFile, type SymbolResolver, type Sym, type TypeScope } from "./symbols";
import { canonicalType, compatible, isElementaryType, isIntegerType } from "./types";
import type { Typer } from "./typing";

/** A value passed to a parameter: its type as written and, for user-defined types, their declaration. */
export interface Receiver {
  readonly type: string;
  readonly sym?: Sym;
  /** A literal, which converts to more types than its own. */
  readonly literal?: "number" | "string" | "bool";
  /** A function used as a value (`f` passed to a parameter of function type). */
  readonly function?: boolean;
}

const CALLABLE = new Set(["function", "event", "error", "struct", "modifier"]);

/** What a call's callee may be: every overload of a function, event or error, or a struct constructor. */
export async function calleeCandidates(typer: Typer, callee: Expr): Promise<MemberDecl[]> {
  if (callee.kind === "member") return (await memberDecls(typer, callee.object, callee.name)).filter((d) => CALLABLE.has(d.decl.kind));
  if (callee.kind !== "name" || typer.isLocal(callee.name)) return [];
  return (await declarationsNamed(typer, callee.name)).filter((d) => CALLABLE.has(d.decl.kind));
}

/** The parameters a call passes its arguments to: struct fields, or parameters without the value of an attached function. */
export function callParams(d: MemberDecl): readonly Param[] {
  if (d.decl.kind === "struct") return (d.decl.members ?? []).map((f) => ({ type: f.type ?? "", name: f.name }));
  return (d.decl.params ?? []).slice(d.bound ? 1 : 0);
}

/**
 * Of several overloads, those a call with `args` can reach, as solc resolves them: as many
 * arguments (or the same names), each implicitly convertible to its parameter. Arguments
 * that cannot be typed fit anything. When no overload takes the arguments' types, those
 * taking as many arguments; when none does, all of them (a call being written).
 */
export async function resolveOverloads<T extends MemberDecl>(typer: Typer, candidates: readonly T[], args: CallArgs): Promise<T[]> {
  if (candidates.length < 2) return [...candidates];
  const { names, values } = args;
  const byArity = candidates.filter((c) => {
    const params = callParams(c);
    return params.length === values.length && (!names || names.every((n) => params.some((p) => p.name === n)));
  });
  if (byArity.length < 2) return byArity.length ? byArity : [...candidates];
  const receivers = await Promise.all(values.map((v) => (v ? receiverOf(typer, v) : undefined)));
  const fits: T[] = [];
  for (const c of byArity) {
    const params = callParams(c);
    if (await takes(typer.resolver, params, receivers, names, typer.resolver.declScope(toSym(c)))) fits.push(c);
  }
  return fits.length ? fits : byArity;
}

/** Of several overloads named by token `k`, those the call there can reach (all when it is not called). */
export async function overloadsCalledAt<T extends MemberDecl>(typer: Typer, structure: SourceStructure, k: number, decls: readonly T[]): Promise<readonly T[]> {
  if (decls.length < 2 || structure.tokens[k + 1]?.text !== "(") return decls;
  return resolveOverloads(typer, decls, callArgs(structure, k + 1));
}

/**
 * The parameter at `index` of each overload a call can still reach, given the arguments
 * written `before` it: what the argument being typed is expected to be.
 */
export async function paramsAt(typer: Typer, candidates: readonly MemberDecl[], before: readonly (Expr | undefined)[], index: number): Promise<Param[]> {
  return (await reachable(typer, candidates, before, index + 1)).map((c) => callParams(c)[index]!);
}

/**
 * Overloads a call being written can still reach: taking at least `minArity` arguments
 * and the types of those written `before` the cursor (by position, or by name with
 * `names`). When the types rule them all out, those taking enough arguments.
 */
export async function reachable<T extends MemberDecl>(
  typer: Typer,
  candidates: readonly T[],
  before: readonly (Expr | undefined)[],
  minArity: number,
  names?: readonly string[],
): Promise<T[]> {
  const open = candidates.filter((c) => {
    const params = callParams(c);
    return params.length >= minArity && (!names || names.every((n) => params.some((p) => p.name === n)));
  });
  if (open.length < 2) return open;
  const receivers = await Promise.all(before.map((v) => (v ? receiverOf(typer, v) : undefined)));
  const fits: T[] = [];
  for (const c of open) if (await takes(typer.resolver, callParams(c), receivers, names, typer.resolver.declScope(toSym(c)))) fits.push(c);
  return fits.length ? fits : open;
}

async function takes(
  resolver: SymbolResolver,
  params: readonly Param[],
  receivers: readonly (Receiver | undefined)[],
  names: readonly string[] | undefined,
  scope: TypeScope,
): Promise<boolean> {
  for (let i = 0; i < receivers.length; i++) {
    const r = receivers[i];
    const p = names ? params.find((x) => x.name === names[i]) : params[i];
    if (r && p && !(await accepts(resolver, r, p.type, scope))) return false;
  }
  return true;
}

/** What an argument is, for overload resolution; undefined when it cannot be typed as a value. */
export async function receiverOf(typer: Typer, expr: Expr): Promise<Receiver | undefined> {
  if (expr.kind === "literal") return { type: expr.type === "number" ? "uint256" : expr.type, literal: expr.type };
  const type = await typer.typeOf(expr);
  if (type?.kind === "function") return { type: "function", function: true };
  if (type?.kind !== "value") return undefined;
  const sym = await typer.typeSym(type);
  const written = stripLocation(type.type);
  return sym ? { type: written, sym } : { type: written };
}

/** Whether a parameter of type `param` (written in `scope`) takes the value: implicit conversions, derived contracts. */
export async function accepts(resolver: SymbolResolver, receiver: Receiver, param: string, scope: TypeScope): Promise<boolean> {
  const p = stripLocation(param);
  // Function types are not compared further.
  if (receiver.function) return p.startsWith("function");
  switch (receiver.literal) {
    // The value is unknown here: any integer, an address or fixed bytes may take it.
    case "number":
      return isIntegerType(p) || p === "address" || p === "address payable" || /^bytes\d+$/.test(p);
    case "string":
      return p === "string" || p === "bytes" || /^bytes\d+$/.test(p);
    case "bool":
      return p === "bool";
  }
  if (isBuiltinType(p) || isBuiltinType(receiver.type)) {
    if (isElementaryType(p) && isElementaryType(receiver.type)) return compatible(receiver.type, p);
    return normalize(p) === normalize(receiver.type);
  }
  const sym = await resolver.resolvePath(scope, p);
  if (!sym || !receiver.sym) return lastName(p) === lastName(receiver.type);
  if (sym.decl === receiver.sym.decl) return true;
  return isContractKind(sym.decl.kind) && (await derivesFrom(resolver, receiver.sym, sym));
}

async function derivesFrom(resolver: SymbolResolver, derived: Sym, base: Sym): Promise<boolean> {
  const node = resolver.contractOf(derived);
  if (!node) return false;
  const seen = new Set<string>();
  const visit = async (c: { file: StructureFile; contract: ContractNode }, depth: number): Promise<boolean> => {
    const key = `${c.file.path}#${c.contract.start}`;
    if (seen.has(key) || depth > 16) return false;
    seen.add(key);
    for (const b of await resolver.bases(c.file, c.contract)) {
      if (b.contract.decl === base.decl || (await visit(b, depth + 1))) return true;
    }
    return false;
  };
  return visit({ file: derived.file, contract: node }, 0);
}

/** Elementary types, arrays, mappings and function types: compared by how they are written. */
export function isBuiltinType(type: string): boolean {
  return isElementaryType(type) || type.endsWith("]") || type.startsWith("mapping(") || type.startsWith("function");
}

/** A type as written, without data location and with `uint`/`int` spelled out. */
export function normalize(type: string): string {
  return canonicalType(stripLocation(type)).replace(/\buint\b/g, "uint256").replace(/\bint\b/g, "int256");
}

function stripLocation(type: string): string {
  return type.replace(/\s+(memory|storage|calldata)$/, "");
}

export function lastName(type: string): string | undefined {
  return type.split(".").at(-1);
}
