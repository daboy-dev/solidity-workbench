import type { Callable, Decl, SourceStructure, StatementSpan } from "../completion/structure";
import { isContractKind, type StructureFile } from "../completion/symbols";
import type { MemberDecl } from "../navigation/memberDefinition";

/** Longest initializer shown for a constant. */
const MAX_INITIALIZER = 120;
/** Signatures longer than this get one parameter per line. */
const MAX_LINE = 100;

/** The declaration whose name starts at `nameStart` in `file`: contracts, their members, struct fields, enum values. */
export function declarationAt(file: StructureFile, nameStart: number): MemberDecl | undefined {
  const { structure } = file;
  const inMembers = (decl: Decl, owner?: MemberDecl["owner"]): MemberDecl | undefined => {
    if (decl.nameStart === nameStart && decl.name) return owner ? { decl, file, owner } : { decl, file };
    const inner = decl.members?.find((m) => m.nameStart === nameStart && m.name);
    if (inner) return owner ? { decl: inner, file, owner, parent: decl } : { decl: inner, file, parent: decl };
    return undefined;
  };
  for (const decl of structure.fileDecls) {
    const found = inMembers(decl);
    if (found) return found;
  }
  for (const contract of structure.contracts) {
    for (const decl of contract.members) {
      const found = inMembers(decl, contract);
      if (found) return found;
    }
  }
  return undefined;
}

/** The function or modifier a declaration of kind `function`/`modifier` heads. */
export function callableOf(structure: SourceStructure, decl: Decl): Callable | undefined {
  return structure.callables.find((c) => c.name === decl.name && c.start <= decl.nameStart && decl.nameStart < c.headerEnd);
}

/** Where a declaration's text (and so its NatSpec) starts. */
export function declarationStart(ref: MemberDecl): number {
  const { structure } = ref.file;
  const { decl } = ref;
  if (isContractKind(decl.kind)) return structure.contracts.find((c) => c.decl === decl)?.start ?? decl.nameStart;
  if (decl.kind === "function" || decl.kind === "modifier") return callableOf(structure, decl)?.start ?? decl.nameStart;
  if (decl.kind === "enumValue" || decl.kind === "module") return decl.nameStart;
  return statementAt(structure, decl.nameStart)?.start ?? decl.nameStart;
}

/** A declaration as one line of Solidity (or a few, for structs and long parameter lists). */
export function signatureOf(ref: MemberDecl): string {
  const { structure } = ref.file;
  const { decl } = ref;
  switch (decl.kind) {
    case "contract":
    case "abstract":
    case "interface":
    case "library": {
      const node = structure.contracts.find((c) => c.decl === decl);
      return node ? withoutTrailing(code(structure, node.start, node.bodyStart)) : `${decl.kind} ${decl.name}`;
    }
    case "function":
    case "modifier": {
      const c = callableOf(structure, decl);
      return breakParams(c ? withoutTrailing(code(structure, c.start, c.headerEnd)) : `${decl.kind} ${decl.name}`);
    }
    case "struct": {
      const fields = (decl.members ?? []).map((f) => `    ${f.type ?? ""} ${f.name};`);
      return fields.length ? `struct ${decl.name} {\n${fields.join("\n")}\n}` : `struct ${decl.name} {}`;
    }
    case "enum": {
      const values = (decl.members ?? []).map((v) => v.name);
      const line = `enum ${decl.name} { ${values.join(", ")} }`;
      return line.length <= MAX_LINE ? line : `enum ${decl.name} {\n${values.map((v) => `    ${v}`).join(",\n")}\n}`;
    }
    case "field":
      return `${decl.type ?? ""} ${ref.parent ? `${ref.parent.name}.` : ""}${decl.name}`.trim();
    case "enumValue":
      return ref.parent ? `${ref.parent.name}.${decl.name}` : decl.name;
    case "module": {
      const imp = ref.file.imports.imports.find((i) => i.unitAlias === decl.name);
      return imp ? `import "${imp.path}" as ${decl.name}` : decl.name;
    }
    case "parameter":
    case "return":
    case "local":
      return [decl.type, decl.location, decl.name].filter(Boolean).join(" ");
    default: {
      // State variables, constants, events, errors, user-defined value types.
      const span = statementAt(structure, decl.nameStart);
      if (!span) return [decl.type, decl.name].filter(Boolean).join(" ");
      return breakParams(statementCode(structure, span, decl.kind === "constant"));
    }
  }
}

/** The innermost statement span containing `offset`. */
function statementAt(structure: SourceStructure, offset: number): StatementSpan | undefined {
  let best: StatementSpan | undefined;
  for (const s of structure.statements) if (s.start <= offset && offset < s.end && (!best || s.end - s.start < best.end - best.start)) best = s;
  return best;
}

/** A statement without its `;`, and without its initializer unless `keepValue`. */
function statementCode(structure: SourceStructure, span: StatementSpan, keepValue: boolean): string {
  const { tokens } = structure;
  let end = span.end;
  let depth = 0;
  for (let k = span.first; k < span.last; k++) {
    const t = tokens[k]!.text;
    if (t === "(" || t === "[" || t === "{") depth++;
    else if (t === ")" || t === "]" || t === "}") depth--;
    else if (t === "=" && depth === 0) {
      if (!keepValue) end = tokens[k]!.start;
      else {
        const valueStart = tokens[k + 1]?.start ?? span.end;
        const value = withoutTrailing(code(structure, valueStart, span.end));
        const head = code(structure, span.start, tokens[k]!.start);
        return `${head} = ${value.length > MAX_INITIALIZER ? `${value.slice(0, MAX_INITIALIZER)}…` : value}`;
      }
      break;
    }
  }
  return withoutTrailing(code(structure, span.start, end));
}

/** Source between two offsets on one line: comments dropped, whitespace collapsed. */
function code(structure: SourceStructure, start: number, end: number): string {
  const { text, trivia } = structure;
  let out = "";
  let pos = start;
  for (const t of trivia) {
    if (t.end <= start || t.kind === "string") continue;
    if (t.start >= end) break;
    out += `${text.slice(pos, Math.max(pos, t.start))} `;
    pos = Math.min(end, Math.max(pos, t.end));
  }
  out += text.slice(pos, end);
  return out
    .replace(/\s+/g, " ")
    .replace(/([([]) /g, "$1")
    .replace(/ ([)\],])/g, "$1")
    .trim();
}

function withoutTrailing(s: string): string {
  return s.replace(/\s*[{;]\s*$/, "");
}

/** `function f(a, b) external` → one parameter per line when the line is too long. */
function breakParams(line: string): string {
  if (line.length <= MAX_LINE) return line;
  const open = line.indexOf("(");
  if (open < 0) return line;
  const parts: string[] = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open + 1; i < line.length; i++) {
    const c = line[i];
    if (c === "(" || c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === ")") {
      if (depth === 0) {
        parts.push(line.slice(from, i).trim());
        const params = parts.filter(Boolean);
        if (!params.length) return line;
        return `${line.slice(0, open + 1)}\n${params.map((p) => `    ${p}`).join(",\n")}\n${line.slice(i)}`;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      parts.push(line.slice(from, i).trim());
      from = i + 1;
    }
  }
  return line;
}
