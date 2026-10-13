import semver from "semver";
import type { CallableKind } from "./structure";

/** A keyword suggestion; `since` gates it by solc version. */
export interface Keyword {
  readonly label: string;
  readonly detail?: string;
  readonly snippet?: string;
  readonly since?: string;
}

const kw = (label: string, detail?: string, extra: Partial<Keyword> = {}): Keyword => ({ label, ...(detail ? { detail } : {}), ...extra });

export const MAPPING: Keyword = kw("mapping", "mapping(KeyType => ValueType)", { snippet: "mapping(${1:KeyType} => ${2:ValueType})" });

export const FILE_KEYWORDS: readonly Keyword[] = [
  kw("pragma"),
  kw("import"),
  kw("contract"),
  kw("abstract"),
  kw("interface"),
  kw("library"),
  kw("struct"),
  kw("enum"),
  kw("error"),
  kw("event"),
  kw("function"),
  kw("type", "user-defined value type"),
  kw("using"),
];

export const CONTRACT_KEYWORDS: readonly Keyword[] = [
  kw("function"),
  kw("modifier"),
  kw("constructor"),
  kw("receive", "receive() external payable"),
  kw("fallback", "fallback() external [payable]"),
  kw("event"),
  kw("error"),
  kw("struct"),
  kw("enum"),
  kw("using"),
  kw("type", "user-defined value type"),
];

export const STATEMENT_KEYWORDS: readonly Keyword[] = [
  kw("if"),
  kw("for"),
  kw("while"),
  kw("do"),
  kw("return"),
  kw("emit"),
  kw("revert"),
  kw("unchecked"),
  kw("try"),
  kw("delete"),
  kw("break"),
  kw("continue"),
  kw("assembly"),
];

export const EXPRESSION_KEYWORDS: readonly Keyword[] = [kw("true"), kw("false"), kw("new"), kw("type", "type(T)"), kw("payable", "payable(address)")];

const VISIBILITY = ["external", "public", "internal", "private"];
const MUTABILITY = ["view", "pure", "payable"];

/** Attributes that may follow a function header, minus those already written. */
export function functionAttributes(callable: CallableKind, used: readonly string[], inContract: boolean): Keyword[] {
  let options: string[];
  switch (callable) {
    case "function":
      options = inContract ? [...VISIBILITY, ...MUTABILITY, "virtual", "override", "returns"] : [...MUTABILITY, "returns"];
      break;
    case "constructor":
      options = ["payable"];
      break;
    case "fallback":
    case "receive":
      options = ["external", "payable", "virtual", "override"];
      break;
    case "modifier":
      options = ["virtual", "override"];
      break;
  }
  const has = (group: readonly string[]) => used.some((u) => group.includes(u));
  return options
    .filter((o) => !used.includes(o))
    .filter((o) => !(VISIBILITY.includes(o) && has(VISIBILITY)) && !(MUTABILITY.includes(o) && has(MUTABILITY)))
    .map((o) => kw(o));
}

const STATE_VISIBILITY = ["public", "private", "internal"];
const STATE_KIND = ["constant", "immutable", "transient"];

/** Attributes after the type of a state variable (or of a file-level constant). */
export function stateAttributes(used: readonly string[], fileLevel: boolean): Keyword[] {
  if (fileLevel) return used.includes("constant") ? [] : [kw("constant")];
  const options: Keyword[] = [
    ...STATE_VISIBILITY.map((v) => kw(v)),
    kw("constant"),
    kw("immutable"),
    kw("transient", "transient storage", { since: "0.8.28" }),
    kw("override"),
  ];
  const has = (group: readonly string[]) => used.some((u) => group.includes(u));
  return options.filter(
    (o) => !used.includes(o.label) && !(STATE_VISIBILITY.includes(o.label) && has(STATE_VISIBILITY)) && !(STATE_KIND.includes(o.label) && has(STATE_KIND)),
  );
}

export const DATA_LOCATION_KEYWORDS: readonly Keyword[] = [kw("memory"), kw("storage"), kw("calldata")];

export function availableKeywords(list: readonly Keyword[], version: string): Keyword[] {
  return list.filter((k) => !k.since || semver.gte(version, k.since));
}
