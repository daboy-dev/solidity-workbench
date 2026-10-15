import { GLOBAL_FUNCTIONS, isAvailable, type Builtin } from "../completion/builtins";
import { calleeCandidates, callParams, reachable } from "../completion/calls";
import { callArgs, cursorContext, parseBackward, type CursorContext, type Expr } from "../completion/cursorContext";
import { declarationsNamed, type MemberDecl } from "../completion/members";
import type { Callable, ContractNode, SourceStructure } from "../completion/structure";
import { isContractKind, type StructureFile, type Sym } from "../completion/symbols";
import { isElementaryType } from "../completion/types";
import type { Typer } from "../completion/typing";
import { builtinMemberOf, natSpecOf, typerFor, type HoverEnv } from "../hover/hover";
import { docCommentBefore, parseNatSpec, type NatSpec } from "../hover/natspec";
import { isInCommentOrString } from "../solidity/lexContext";

export interface SignatureParameter {
  /** Offsets of the parameter in the signature's label. */
  readonly label: readonly [number, number];
  /** Markdown. */
  readonly documentation?: string;
}

export interface Signature {
  readonly label: string;
  /** Markdown. */
  readonly documentation?: string;
  readonly parameters: readonly SignatureParameter[];
  /** The parameter the argument at the cursor goes to (out of range when none). */
  readonly activeParameter: number;
}

export interface SignatureHelp {
  /** Every overload of what is called. */
  readonly signatures: readonly Signature[];
  /** The first overload the arguments written so far can reach. */
  readonly activeSignature: number;
}

/** A callable as signature help shows it. */
interface Shape {
  readonly prefix: string;
  readonly params: ReadonlyArray<{ readonly text: string; readonly name?: string }>;
  readonly suffix: string;
  readonly spec?: NatSpec;
  /** Builtins such as `abi.encode(...)`: the last parameter takes any number of arguments. */
  readonly variadic?: boolean;
  readonly doc?: string;
  /** For overload resolution. */
  readonly member?: MemberDecl;
}

/** Lists opened right after these words declare parameters; they are not calls. */
const DECLARATION_LISTS = new Set(["constructor", "fallback", "receive", "returns", "mapping", "function"]);
const DECLARING = new Set(["function", "modifier", "event", "error", "catch"]);
/** Parentheses after these words are not calls whose signature helps: statements, conversions. */
const NOT_CALLS = new Set(["if", "while", "for", "return", "type", "payable", "emit", "unchecked"]);

/**
 * Signature help at `offset`: the parameters of the call being written, with the NatSpec
 * of the declaration and of each parameter. Covers functions and members (attached with
 * `using ... for` included, without the value they are called on), events after `emit`,
 * errors after `revert`, struct constructors (`S(...)` and `S({...})`), `new C(...)`,
 * modifiers and base constructors in headers, and built-in functions. Never runs solc.
 */
export async function signatureHelpAt(structure: SourceStructure, offset: number, env: HoverEnv): Promise<SignatureHelp | undefined> {
  if (isInCommentOrString(structure.trivia, offset) || structure.silent.some(([a, b]) => a <= offset && offset <= b)) return undefined;
  const { tokens, pairs } = structure;
  const groups = openGroups(structure, offset);
  let typer: Typer | undefined;
  let ctx: CursorContext | undefined;
  for (let j = groups.length - 1; j >= 0; j--) {
    let open = groups[j]!;
    let brace: number | undefined;
    const t = tokens[open]!.text;
    if (t === "[") continue;
    if (t === "{") {
      // Named arguments: `f({a: 1, |})`. Any other brace is a block or call options.
      if (tokens[open - 1]?.text !== "(" || groups[j - 1] !== open - 1) return undefined;
      brace = open;
      open = open - 1;
      j--;
    }
    const prev = tokens[open - 1];
    if (!prev) continue;
    if (DECLARATION_LISTS.has(prev.text) || (prev.kind === "ident" && DECLARING.has(tokens[open - 2]?.text ?? ""))) return undefined;
    if (!(prev.kind === "ident" || prev.text === ")" || prev.text === "]" || prev.text === "}")) continue;
    ctx ??= cursorContext(structure, offset);
    typer ??= typerFor(ctx, env);
    // `new bytes(n)`, `new uint256[](n)`: the length.
    const allocated = allocation(structure, open);
    if (allocated) return positional(structure, open, offset, [{ prefix: `new ${allocated}`, params: [{ text: "uint256 length" }], suffix: "" }], typer);
    if (NOT_CALLS.has(prev.text) || isElementaryType(prev.text)) continue;
    // `x.call{value: v}(...)`: the callee is before the options.
    const calleeEnd = prev.text === "}" ? (pairs.open[open - 1] ?? -1) - 1 : open - 1;
    const callee = calleeEnd >= 0 ? parseBackward(structure, calleeEnd) : undefined;
    if (!callee) continue;
    const shapes = await shapesOf(callee.expr, typer, structure, offset, env.version);
    // A conversion (`IERC20(x)`): the signature of an enclosing call helps more.
    if (shapes === "conversion") continue;
    if (!shapes.length) return undefined;
    return brace === undefined ? positional(structure, open, offset, shapes, typer) : named(structure, open, brace, offset, shapes, typer);
  }
  return undefined;
}

/** The type allocated when the call opened at `open` is `new bytes(...)`, `new string(...)` or `new T[](...)`. */
function allocation(structure: SourceStructure, open: number): string | undefined {
  const { tokens, pairs } = structure;
  let k = open - 1;
  let dims = "";
  while (tokens[k]?.text === "]") {
    const o = pairs.open[k]!;
    if (o < 0) return undefined;
    dims = typeTextOf(structure, o, k + 1) + dims;
    k = o - 1;
  }
  let first = k;
  while (tokens[first - 1]?.text === "." && tokens[first - 2]?.kind === "ident") first -= 2;
  if (tokens[k]?.kind !== "ident" || tokens[first - 1]?.text !== "new") return undefined;
  const name = typeTextOf(structure, first, k + 1);
  return dims || name === "bytes" || name === "string" ? name + dims : undefined;
}

function typeTextOf(structure: SourceStructure, from: number, to: number): string {
  return structure.tokens
    .slice(from, to)
    .map((t) => t.text)
    .join("");
}

/** Brackets open at `offset`, outermost first. */
function openGroups(structure: SourceStructure, offset: number): number[] {
  const { tokens, pairs } = structure;
  const stack: number[] = [];
  for (let k = 0; k < tokens.length && tokens[k]!.start < offset; k++) {
    const t = tokens[k]!.text;
    if (t === "(" || t === "[" || t === "{") stack.push(k);
    else if (t === ")" || t === "]" || t === "}") {
      const o = pairs.open[k]!;
      const at = stack.lastIndexOf(o);
      if (at >= 0) stack.length = at;
    }
  }
  return stack;
}

async function positional(structure: SourceStructure, open: number, offset: number, shapes: readonly Shape[], typer: Typer): Promise<SignatureHelp> {
  const { tokens, pairs } = structure;
  let index = 0;
  let typed = false;
  for (let k = open + 1; k < tokens.length && tokens[k]!.start < offset; k++) {
    const t = tokens[k]!.text;
    typed = true;
    if (t === ",") index++;
    else if (t === "(" || t === "[" || t === "{") {
      const c = pairs.close[k]!;
      if (c <= k || c >= tokens.length || tokens[c]!.start >= offset) break;
      k = c;
    }
  }
  // The argument being written counts too: a name already typed in full has a type, a prefix fits anything.
  const before = callArgs(structure, open).values.slice(0, typed ? index + 1 : index);
  const minArity = index === 0 && !typed ? 0 : index + 1;
  const active = await activeOf(shapes, (members) => reachable(typer, members, before, minArity));
  return {
    activeSignature: active,
    signatures: shapes.map((s) => signature(s, s.variadic ? Math.min(index, s.params.length - 1) : index)),
  };
}

async function named(structure: SourceStructure, open: number, brace: number, offset: number, shapes: readonly Shape[], typer: Typer): Promise<SignatureHelp> {
  const { tokens, pairs } = structure;
  let segment = brace + 1;
  for (let k = brace + 1; k < tokens.length && tokens[k]!.start < offset; k++) {
    const t = tokens[k]!.text;
    if (t === ",") segment = k + 1;
    else if (t === "(" || t === "[" || t === "{") {
      const c = pairs.close[k]!;
      if (c <= k || c >= tokens.length || tokens[c]!.start >= offset) break;
      k = c;
    }
  }
  const head = tokens[segment];
  const colon = tokens[segment + 1];
  // After `name:` the argument goes to that parameter; while writing a name, to the first one not given yet.
  const current = head?.kind === "ident" && colon?.text === ":" && colon.start < offset ? head.text : undefined;
  const { names = [], values } = callArgs(structure, open);
  const active = await activeOf(shapes, (members) => reachable(typer, members, values, 0, names));
  return {
    activeSignature: active,
    signatures: shapes.map((s) => {
      const i = current !== undefined ? s.params.findIndex((p) => p.name === current) : s.params.findIndex((p) => p.name !== undefined && !names.includes(p.name));
      return signature(s, i < 0 ? s.params.length : i);
    }),
  };
}

async function activeOf(shapes: readonly Shape[], pick: (members: MemberDecl[]) => Promise<MemberDecl[]>): Promise<number> {
  const members = shapes.flatMap((s) => (s.member ? [s.member] : []));
  if (members.length < 2) return 0;
  const [first] = await pick(members);
  const i = shapes.findIndex((s) => s.member === first);
  return i < 0 ? 0 : i;
}

function signature(shape: Shape, activeParameter: number): Signature {
  let label = shape.prefix + "(";
  const parameters: SignatureParameter[] = [];
  shape.params.forEach((p, i) => {
    if (i > 0) label += ", ";
    const start = label.length;
    label += p.text;
    const doc = p.name ? shape.spec?.params.find((d) => d.name === p.name)?.text : undefined;
    parameters.push(doc ? { label: [start, label.length], documentation: doc } : { label: [start, label.length] });
  });
  label += ")" + shape.suffix;
  const doc = shape.doc ?? (shape.spec ? [shape.spec.notice, shape.spec.dev].filter(Boolean).join("\n\n") : undefined);
  return { label, parameters, activeParameter, ...(doc ? { documentation: doc } : {}) };
}

// ---- what is called ----------------------------------------------------------------

async function shapesOf(callee: Expr, typer: Typer, structure: SourceStructure, offset: number, version: string): Promise<Shape[] | "conversion"> {
  const { resolver } = typer;
  if (callee.kind === "new") {
    const sym = await resolver.resolvePath(typer.at, callee.type);
    return sym ? constructorShapes(sym, typer, `new ${callee.type}`) : [];
  }
  if (callee.kind === "name" && inHeader(structure, offset)) {
    // Modifiers and base constructors: `onlyOwner`, `ERC20("Token", "TKN")`.
    const out: Shape[] = [];
    for (const d of await declarationsNamed(typer, callee.name)) {
      if (d.decl.kind === "modifier") out.push(await memberShape(d, typer));
      else if (isContractKind(d.decl.kind)) out.push(...(await constructorShapes({ name: callee.name, decl: d.decl, file: d.file }, typer, callee.name)));
    }
    // Otherwise a call inside their arguments: `onlyRole(getRoleAdmin(role))`.
    if (out.length) return out;
  }
  // `T.wrap(x)` and `T.unwrap(t)` of a user-defined value type.
  if (callee.kind === "member" && (callee.name === "wrap" || callee.name === "unwrap")) {
    const owner = await typer.typeOf(callee.object);
    if (owner?.kind === "static" && owner.sym?.decl.kind === "type") {
      const underlying = owner.sym.decl.type ?? "";
      const [from, to] = callee.name === "wrap" ? [underlying, owner.type] : [owner.type, underlying];
      return [{ prefix: `${owner.type}.${callee.name}`, params: [{ text: `${from} value` }], suffix: ` returns (${to})` }];
    }
  }
  const candidates = await calleeCandidates(typer, callee);
  if (candidates.length) return Promise.all(candidates.map((d) => memberShape(d, typer)));
  const type = await typer.typeOf(callee);
  if (type?.kind === "static" && type.sym && isContractKind(type.sym.decl.kind)) return "conversion";
  // A variable of function type: `function(bytes32, bytes32) view returns (bytes32) hasher; hasher(a, b)`.
  if (type?.kind === "value" && type.type.startsWith("function(")) {
    const close = matchingParen(type.type, "function".length);
    const inner = type.type.slice("function(".length, close).trim();
    const returns = /\breturns\s*(\(.*\))\s*$/.exec(type.type)?.[1];
    const name = callee.kind === "name" || callee.kind === "member" ? callee.name : "function";
    return [{ prefix: name, params: inner ? splitTop(inner).map((text) => ({ text })) : [], suffix: returns ? ` returns ${returns}` : "" }];
  }
  if (callee.kind === "name") {
    if (typer.isLocal(callee.name)) return [];
    return GLOBAL_FUNCTIONS.filter((b) => b.name === callee.name && isAvailable(b, version)).map((b) => builtinShape(b, ""));
  }
  if (callee.kind === "member") {
    const found = await builtinMemberOf(typer, await typer.typeOf(callee.object), callee.name);
    return found && found.builtin.kind === "function" && isAvailable(found.builtin, version) ? [builtinShape(found.builtin, found.owner)] : [];
  }
  return [];
}

/** In a function's header (modifiers, base constructors) or a contract's `is` list. */
function inHeader(structure: SourceStructure, offset: number): boolean {
  if (structure.callables.some((c) => c.start <= offset && offset <= c.headerEnd)) return true;
  return structure.contracts.some((c) => c.start <= offset && offset < c.bodyStart);
}

const KIND_PREFIX: Readonly<Record<string, string>> = { function: "function ", modifier: "modifier ", event: "event ", error: "error ", struct: "struct " };

async function memberShape(d: MemberDecl, typer: Typer): Promise<Shape> {
  const returns = d.decl.returns?.length ? ` returns (${d.decl.returns.map(paramText).join(", ")})` : "";
  const spec = await natSpecOf(d, typer.resolver);
  return {
    prefix: `${KIND_PREFIX[d.decl.kind] ?? ""}${d.decl.name}`,
    params: callParams(d).map((p) => ({ text: paramText(p), ...(p.name ? { name: p.name } : {}) })),
    suffix: returns,
    member: d,
    ...(spec ? { spec } : {}),
  };
}

/** The constructor of a contract (none written: no parameters). */
async function constructorShapes(sym: Sym, typer: Typer, prefix: string): Promise<Shape[]> {
  const node = typer.resolver.contractOf(sym);
  if (!node) return [];
  const ctor = constructorOf(sym.file, node);
  const comment = ctor && docCommentBefore(sym.file.structure, ctor.start);
  const spec = comment ? parseNatSpec(comment) : undefined;
  return [
    {
      prefix,
      params: (ctor?.params ?? []).map((p) => ({ text: paramText({ type: p.type ?? "", ...(p.location ? { location: p.location } : {}), ...(p.name ? { name: p.name } : {}) }), ...(p.name ? { name: p.name } : {}) })),
      suffix: "",
      ...(spec ? { spec } : {}),
    },
  ];
}

function constructorOf(file: StructureFile, node: ContractNode): Callable | undefined {
  return file.structure.callables.find((c) => c.kind === "constructor" && c.owner?.decl === node.decl);
}

/** A built-in function from its catalog signature: `(bytes memory) returns (bytes32)`. */
function builtinShape(b: Builtin, owner: string): Shape {
  const sig = b.signature ?? "()";
  const close = matchingParen(sig, 0);
  const inner = sig.slice(1, close).trim();
  const params = inner ? splitTop(inner).map((text) => ({ text })) : [];
  return {
    prefix: owner ? `${owner}.${b.name}` : b.name,
    params,
    suffix: sig.slice(close + 1),
    variadic: params.at(-1)?.text.includes("...") ?? false,
    doc: b.doc,
  };
}

function matchingParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return s.length;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out;
}

function paramText(p: { readonly type: string; readonly location?: string; readonly name?: string }): string {
  return [p.type, p.location, p.name].filter(Boolean).join(" ");
}
