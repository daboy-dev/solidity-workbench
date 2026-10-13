import {
  ABI,
  BLOCK,
  CONTRACT_TYPE_INFO,
  ENUM_TYPE_INFO,
  GLOBAL_FUNCTIONS,
  GLOBAL_VALUES,
  INTERFACE_TYPE_INFO,
  MSG,
  TX,
  UNITS,
  isAvailable,
  isDeprecated,
  type Builtin,
} from "./builtins";
import type { CursorContext } from "./cursorContext";
import { builtinTypeOf, elementaryTypeInfo, staticMembers, valueMembers, type ExprType } from "./types";

export type EntryKind =
  | "keyword"
  | "type"
  | "variable"
  | "parameter"
  | "field"
  | "property"
  | "function"
  | "method"
  | "event"
  | "error"
  | "struct"
  | "enum"
  | "enumMember"
  | "contract"
  | "interface"
  | "library"
  | "modifier"
  | "constant"
  | "unit"
  | "namespace";

/**
 * Groups in which suggestions are listed when VS Code's fuzzy score ties: what fits
 * the expected type first, then the scope, the language and the globals. Auto-import
 * suggestions come after all of them.
 */
export const RANK = {
  match: 0,
  compatible: 1,
  local: 2,
  member: 3,
  keyword: 4,
  global: 5,
} as const;

export interface CompletionEntry {
  readonly label: string;
  readonly kind: EntryKind;
  /** Short text next to the label: a type or a signature. */
  readonly detail?: string;
  /** Markdown. */
  readonly documentation?: string;
  readonly rank: number;
  readonly deprecated?: boolean;
  /** Snippet syntax to insert instead of the label. */
  readonly snippet?: string;
}

export interface CompletionEnv {
  /** The solc version the file is compiled with (at least 0.8.0). */
  readonly version: string;
}

/** Collects entries, the first one of each label winning. */
class Entries {
  readonly list: CompletionEntry[] = [];
  private readonly seen = new Set<string>();

  add(entry: CompletionEntry): void {
    if (this.seen.has(entry.label)) return;
    this.seen.add(entry.label);
    this.list.push(entry);
  }

  builtins(list: readonly Builtin[], env: CompletionEnv, rank: number, asMember: boolean): void {
    for (const b of list) {
      if (!isAvailable(b, env.version)) continue;
      this.add(builtinEntry(b, env, rank, asMember));
    }
  }
}

export function builtinEntry(b: Builtin, env: CompletionEnv, rank: number, asMember: boolean): CompletionEntry {
  const deprecated = isDeprecated(b, env.version);
  const kind: EntryKind = b.kind === "function" ? (asMember ? "method" : "function") : asMember ? "property" : "variable";
  const detail = b.kind === "function" ? `${b.name}${b.signature ?? "()"}` : b.type || undefined;
  const documentation = deprecated && b.deprecation ? `${b.doc}\n\n**${b.deprecation}**` : b.doc;
  return { label: b.name, kind, rank, documentation, ...(detail ? { detail } : {}), ...(deprecated ? { deprecated } : {}) };
}

/** Suggestions for the cursor, in priority order. */
export async function complete(ctx: CursorContext, env: CompletionEnv): Promise<CompletionEntry[]> {
  const out = new Entries();
  const site = ctx.site;
  switch (site.kind) {
    case "member": {
      const type = builtinTypeOf(site.receiver);
      if (type) memberEntries(out, type, env);
      break;
    }
    case "unit":
      for (const b of UNITS) out.add({ ...builtinEntry(b, env, RANK.keyword, false), kind: "unit" });
      break;
    case "statement":
    case "expression":
      if (site.kind === "expression" && site.keyword) break;
      globalEntries(out, env);
      break;
    default:
      break;
  }
  return out.list;
}

function globalEntries(out: Entries, env: CompletionEnv): void {
  for (const b of GLOBAL_VALUES) out.add({ ...builtinEntry(b, env, RANK.global, false), kind: b.name === "this" || b.name === "super" ? "keyword" : "namespace" });
  out.builtins(GLOBAL_FUNCTIONS, env, RANK.global, false);
}

function memberEntries(out: Entries, type: ExprType, env: CompletionEnv): void {
  switch (type.kind) {
    case "namespace":
      out.builtins({ msg: MSG, block: BLOCK, tx: TX, abi: ABI }[type.name], env, RANK.member, true);
      return;
    case "value":
      out.builtins(valueMembers(type.type), env, RANK.member, true);
      return;
    case "static":
      out.builtins(staticMembers(type.type), env, RANK.member, true);
      return;
    case "typeInfo": {
      const elementary = elementaryTypeInfo(type.of);
      if (elementary) out.builtins(elementary, env, RANK.member, true);
      // Without knowing what X is, offer what any contract, interface or enum may have.
      else out.builtins([...CONTRACT_TYPE_INFO, ...INTERFACE_TYPE_INFO, ...ENUM_TYPE_INFO], env, RANK.member, true);
      return;
    }
    case "this":
    case "super":
      return;
  }
}
