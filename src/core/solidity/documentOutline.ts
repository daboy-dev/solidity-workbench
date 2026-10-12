import { extractSymbolsWithRegex } from "./extractSymbols";

export type OutlineKind =
  | "contract"
  | "abstract"
  | "interface"
  | "library"
  | "struct"
  | "enum"
  | "enumValue"
  | "error"
  | "event"
  | "type"
  | "function"
  | "constructor"
  | "fallback"
  | "receive"
  | "modifier"
  | "stateVariable"
  | "constant"
  | "field";

/** A node of a document's outline. Offsets are UTF-16, end exclusive. */
export interface OutlineNode {
  readonly name: string;
  readonly kind: OutlineKind;
  /** e.g. "external view", "uint256", "abstract contract". */
  readonly detail: string;
  readonly start: number;
  readonly end: number;
  readonly nameStart: number;
  readonly nameEnd: number;
  readonly children: readonly OutlineNode[];
  /** Base contracts as written (`Ownable`, `Lib.Base`), for contracts, interfaces and libraries. */
  readonly bases?: readonly string[];
}

interface Node {
  type: string;
  name?: string | null;
  kind?: string;
  range?: [number, number];
  subNodes?: Node[];
  members?: Node[];
  variables?: Node[];
  typeName?: { type: string; name?: string; namePath?: string; keyType?: unknown } | null;
  visibility?: string;
  stateMutability?: string | null;
  isConstructor?: boolean;
  isFallback?: boolean;
  isReceiveEther?: boolean;
  isDeclaredConst?: boolean;
  isImmutable?: boolean;
  identifier?: { range?: [number, number] } | null;
  baseContracts?: Array<{ baseName?: { namePath?: string } }>;
}

/** Builds the outline from a (possibly partial) @solidity-parser/parser AST. */
export function outlineFromAst(text: string, children: readonly unknown[]): OutlineNode[] {
  const out: OutlineNode[] = [];
  for (const child of children) {
    const node = toOutline(text, child as Node, true);
    if (node) out.push(...node);
  }
  return out;
}

function toOutline(text: string, node: Node, topLevel: boolean): OutlineNode[] | undefined {
  if (!node?.range) return undefined;
  const start = node.range[0];
  const end = node.range[1] + 1;
  const make = (name: string, kind: OutlineKind, detail: string, children: OutlineNode[] = [], nameHint?: [number, number]): OutlineNode => {
    const [nameStart, nameEnd] = nameHint ?? findName(text, name, start, end);
    return { name, kind, detail, start, end, nameStart, nameEnd, children };
  };

  switch (node.type) {
    case "ContractDefinition": {
      const kind = (node.kind === "abstract" || node.kind === "interface" || node.kind === "library" ? node.kind : "contract") as OutlineKind;
      const members = (node.subNodes ?? []).flatMap((n) => toOutline(text, n, false) ?? []);
      const bases = (node.baseContracts ?? []).map((b) => b.baseName?.namePath).filter((b): b is string => !!b);
      const detail = node.kind === "abstract" ? "abstract contract" : (node.kind ?? "contract");
      return [{ ...make(node.name ?? "", kind, detail, members), bases }];
    }
    case "StructDefinition":
      return [make(node.name ?? "", "struct", "struct", (node.members ?? []).flatMap((m) => variableNode(text, m) ?? []))];
    case "EnumDefinition":
      return [
        make(
          node.name ?? "",
          "enum",
          "enum",
          (node.members ?? []).flatMap((m) => (m.range ? [leaf(text, m.name ?? "", "enumValue", "", m.range)] : [])),
        ),
      ];
    case "CustomErrorDefinition":
      return [make(node.name ?? "", "error", "error")];
    case "EventDefinition":
      return [make(node.name ?? "", "event", "event")];
    case "TypeDefinition":
      return [make(node.name ?? "", "type", "user-defined value type")];
    case "FileLevelConstant":
      return [make(node.name ?? "", "constant", typeLabel(node.typeName))];
    case "ModifierDefinition":
      return [make(node.name ?? "", "modifier", "modifier")];
    case "FunctionDefinition": {
      const detail = [node.visibility && node.visibility !== "default" ? node.visibility : "", node.stateMutability ?? ""].filter(Boolean).join(" ");
      if (node.isConstructor) return [make("constructor", "constructor", detail, [], keywordRange(text, "constructor", start, end))];
      if (node.isFallback) return [make("fallback", "fallback", detail, [], keywordRange(text, "fallback", start, end))];
      if (node.isReceiveEther) return [make("receive", "receive", detail, [], keywordRange(text, "receive", start, end))];
      return node.name ? [make(node.name, "function", topLevel ? "free function" : detail)] : undefined;
    }
    case "StateVariableDeclaration": {
      // One declaration statement may declare a single variable; keep the statement range.
      return (node.variables ?? []).flatMap((v) => {
        const kind: OutlineKind = v.isDeclaredConst ? "constant" : "stateVariable";
        const detail = [typeLabel(v.typeName), v.isImmutable ? "immutable" : ""].filter(Boolean).join(" ");
        return v.name ? [make(v.name, kind, detail)] : [];
      });
    }
    default:
      return undefined;
  }
}

function variableNode(text: string, v: Node): OutlineNode[] | undefined {
  if (!v.range || !v.name) return undefined;
  return [leaf(text, v.name, "field", typeLabel(v.typeName), v.range)];
}

function leaf(text: string, name: string, kind: OutlineKind, detail: string, range: [number, number]): OutlineNode {
  const start = range[0];
  const end = range[1] + 1;
  const [nameStart, nameEnd] = findName(text, name, start, end);
  return { name, kind, detail, start, end, nameStart, nameEnd, children: [] };
}

function typeLabel(typeName: Node["typeName"]): string {
  if (!typeName) return "";
  switch (typeName.type) {
    case "ElementaryTypeName":
    case "UserDefinedTypeName":
      return typeName.name ?? typeName.namePath ?? "";
    case "Mapping":
      return "mapping";
    case "ArrayTypeName":
      return "array";
    case "FunctionTypeName":
      return "function";
    default:
      return "";
  }
}

/** Range of `name` as a whole word inside [start, end), skipping the declaration keyword. */
function findName(text: string, name: string, start: number, end: number): [number, number] {
  if (name) {
    const re = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`, "g");
    re.lastIndex = start;
    const slice = text.slice(0, end);
    const m = re.exec(slice);
    if (m) return [m.index, m.index + name.length];
  }
  return [start, Math.min(end, start + 1)];
}

function keywordRange(text: string, keyword: string, start: number, end: number): [number, number] {
  return findName(text, keyword, start, end);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Outline of last resort when the parser fails: top-level declarations only, as single lines. */
export function outlineFromRegex(text: string): OutlineNode[] {
  const lines = text.split("\n");
  const lineStarts: number[] = [];
  let acc = 0;
  for (const l of lines) {
    lineStarts.push(acc);
    acc += l.length + 1;
  }
  return extractSymbolsWithRegex(text).map((s) => {
    const lineStart = lineStarts[s.line] ?? 0;
    const lineEnd = lineStart + (lines[s.line]?.length ?? 0);
    const [nameStart, nameEnd] = findName(text, s.name, lineStart + s.character, lineEnd);
    return {
      name: s.name,
      kind: s.kind as OutlineKind,
      detail: s.kind === "abstract" ? "abstract contract" : s.kind === "function" ? "free function" : s.kind,
      start: lineStart + s.character,
      end: lineEnd,
      nameStart,
      nameEnd,
      children: [],
    };
  });
}
