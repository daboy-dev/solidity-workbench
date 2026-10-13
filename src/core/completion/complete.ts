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
import {
  availableKeywords,
  CONTRACT_KEYWORDS,
  DATA_LOCATION_KEYWORDS,
  EXPRESSION_KEYWORDS,
  FILE_KEYWORDS,
  functionAttributes,
  MAPPING,
  STATEMENT_KEYWORDS,
  stateAttributes,
  type Keyword,
} from "./keywords";
import { DATA_LOCATIONS } from "./structure";
import { builtinTypeOf, elementaryTypeInfo, ELEMENTARY_TYPES, isReferenceType, staticMembers, valueMembers, type ExprType } from "./types";

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

  keywords(list: readonly Keyword[], env: CompletionEnv): void {
    for (const k of availableKeywords(list, env.version)) {
      this.add({ label: k.label, kind: "keyword", rank: RANK.keyword, ...(k.detail ? { detail: k.detail } : {}), ...(k.snippet ? { snippet: k.snippet } : {}) });
    }
  }

  /** Elementary types; `address payable` only where a type is declared (not in conversions). */
  types(options: { payable: boolean }): void {
    for (const t of ELEMENTARY_TYPES) {
      this.add({ label: t, kind: "type", rank: RANK.keyword });
      if (t === "address" && options.payable) this.add({ label: "address payable", kind: "type", rank: RANK.keyword });
    }
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
    case "none":
      break;
    case "member": {
      const type = builtinTypeOf(site.receiver);
      if (type) memberEntries(out, type, env);
      break;
    }
    case "unit":
      for (const b of UNITS) out.add({ ...builtinEntry(b, env, RANK.keyword, false), kind: "unit" });
      break;
    case "fileLevel":
      out.keywords(FILE_KEYWORDS, env);
      out.types({ payable: true });
      break;
    case "afterAbstract":
      out.keywords([{ label: "contract" }], env);
      break;
    case "contractLevel":
      out.keywords(CONTRACT_KEYWORDS, env);
      out.keywords([MAPPING], env);
      out.types({ payable: true });
      break;
    case "structField":
      out.keywords([MAPPING], env);
      out.types({ payable: true });
      break;
    case "afterType":
      afterType(out, site, env);
      break;
    case "functionAttributes":
      out.keywords(functionAttributes(site.callable, site.used, ctx.contract !== undefined), env);
      break;
    case "typeName":
      if (site.purpose === "using" || site.purpose === "inheritance" || site.purpose === "override") break;
      if (site.purpose === "param" || site.purpose === "mapping") out.keywords([MAPPING], env);
      out.types({ payable: site.purpose !== "new" && site.purpose !== "udvt" });
      break;
    case "statement":
      out.keywords(STATEMENT_KEYWORDS, env);
      out.types({ payable: true });
      out.keywords([MAPPING], env);
      out.keywords(EXPRESSION_KEYWORDS, env);
      globalEntries(out, env);
      break;
    case "expression":
      if (site.keyword) break;
      out.types({ payable: false });
      out.keywords(EXPRESSION_KEYWORDS, env);
      globalEntries(out, env);
      break;
    case "callOption":
      for (const option of ["value", "gas"]) {
        if (!site.given.includes(option)) out.add({ label: option, kind: "property", detail: "uint256", rank: RANK.member });
      }
      break;
    case "namedArgName":
      break;
  }
  return out.list;
}

function afterType(out: Entries, site: Extract<CursorContext["site"], { kind: "afterType" }>, env: CompletionEnv): void {
  if (site.type === "address" && site.used.length === 0) out.keywords([{ label: "payable" }], env);
  switch (site.where) {
    case "state":
    case "file":
      out.keywords(stateAttributes(site.used, site.where === "file"), env);
      return;
    case "eventParam":
      if (!site.used.includes("indexed")) out.keywords([{ label: "indexed" }], env);
      return;
    case "local":
    case "param":
      if (isReferenceType(site.type) && !site.used.some((u) => DATA_LOCATIONS.has(u))) out.keywords(DATA_LOCATION_KEYWORDS, env);
      return;
  }
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
