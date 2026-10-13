import { GLOBAL_FUNCTIONS } from "./builtins";
import type { Expr } from "./cursorContext";
import type { Decl } from "./structure";
import { isContractKind, type Sym, type SymbolResolver, type TypeScope } from "./symbols";
import { builtinTypeOf, indexedType, isElementaryType, valueMembers, type ExprType } from "./types";

/**
 * Types expressions at the cursor: parameters and locals, members of the
 * contract (inherited included), names visible at file level, and members of
 * user-defined types (struct fields, contract functions, library members).
 */
export class Typer {
  constructor(
    readonly resolver: SymbolResolver,
    /** The file and contract of the cursor. */
    readonly at: TypeScope,
    private readonly locals: readonly Decl[],
  ) {}

  async typeOf(expr: Expr): Promise<ExprType | undefined> {
    switch (expr.kind) {
      case "name":
        return this.nameType(expr.name);
      case "member":
        return this.memberType(await this.typeOf(expr.object), expr.name);
      case "call":
        return this.callType(expr);
      case "index": {
        const object = await this.typeOf(expr.object);
        if (object?.kind !== "value") return undefined;
        const element = indexedType(object.type);
        return element ? value(element, object.at) : undefined;
      }
      case "typeOf":
        return { kind: "typeInfo", of: expr.type, at: this.at };
      case "new":
        return value(expr.type, this.at);
      case "literal":
        return builtinTypeOf(expr);
    }
  }

  private async nameType(name: string): Promise<ExprType | undefined> {
    const local = this.locals.find((d) => d.name === name);
    if (local) return local.type ? value(local.type, this.at) : undefined;
    const builtin = builtinTypeOf({ kind: "name", name });
    if (builtin) return builtin;
    const sym = await this.resolver.resolveName(this.at, name);
    return sym ? this.symType(sym) : undefined;
  }

  /** What a symbol is when named in an expression. */
  symType(sym: Sym): ExprType | undefined {
    const decl = sym.decl;
    switch (decl.kind) {
      case "contract":
      case "abstract":
      case "interface":
      case "library":
      case "struct":
      case "enum":
      case "type":
      case "module":
      case "event":
      case "error":
        return { kind: "static", type: sym.name, sym };
      case "function":
        return { kind: "function", sym, external: false };
      case "enumValue":
        return undefined;
      default:
        return decl.type ? value(decl.type, this.resolver.declScope(sym)) : undefined;
    }
  }

  /** `object.name`, given the type of `object`. */
  async memberType(object: ExprType | undefined, name: string): Promise<ExprType | undefined> {
    if (!object) return undefined;
    switch (object.kind) {
      case "namespace":
        return builtinTypeOf({ kind: "member", object: { kind: "name", name: object.name }, name });
      case "value": {
        const sym = await this.typeSym(object);
        if (!sym) {
          // Elementary values: address members, array length...
          return builtinValueMember(object.type, name);
        }
        if (sym.decl.kind === "struct") {
          const field = sym.decl.members?.find((f) => f.name === name);
          return field?.type ? value(field.type, this.resolver.declScope(sym)) : undefined;
        }
        if (isContractKind(sym.decl.kind)) {
          // Functions, and public state variables read through their getters.
          const member = await this.resolver.memberNamed(sym, name);
          return member && (member.decl.kind === "function" || member.decl.type) ? { kind: "function", sym: member, external: true } : undefined;
        }
        return undefined;
      }
      case "static": {
        const owner = object.sym;
        if (!owner) return builtinTypeOf({ kind: "member", object: { kind: "name", name: object.type }, name });
        if (owner.decl.kind === "enum") return owner.decl.members?.some((m) => m.name === name) ? value(owner.name, this.resolver.declScope(owner)) : undefined;
        const member = await this.resolver.memberNamed(owner, name);
        return member ? this.symType(member) : undefined;
      }
      case "this": {
        const member = this.at.contract && (await this.resolver.members(this.at.file, this.at.contract)).find((s) => s.name === name);
        return member && member.decl.kind === "function" ? { kind: "function", sym: member, external: true } : undefined;
      }
      case "super": {
        if (!this.at.contract) return undefined;
        for (const base of await this.resolver.bases(this.at.file, this.at.contract)) {
          const member = (await this.resolver.members(base.file, base.contract)).find((s) => s.name === name);
          if (member) return this.symType(member);
        }
        return undefined;
      }
      case "function":
        if (name === "selector") return value("bytes4");
        if (name === "address") return value("address");
        return undefined;
      case "typeInfo":
        return undefined;
    }
  }

  private async callType(expr: Extract<Expr, { kind: "call" }>): Promise<ExprType | undefined> {
    const callee = expr.callee;
    if (callee.kind === "name") {
      if (callee.name === "payable") return value("address payable");
      if (isElementaryType(callee.name)) return value(callee.name);
      if (!this.locals.some((d) => d.name === callee.name)) {
        const global = GLOBAL_FUNCTIONS.find((b) => b.name === callee.name);
        if (global) return global.type ? value(global.type) : undefined;
      }
    }
    const type = await this.typeOf(callee);
    if (!type) return undefined;
    if (type.kind === "static") {
      const sym = type.sym;
      if (!sym) return builtinTypeOf(expr);
      // Conversions to contract types and struct constructors.
      if (isContractKind(sym.decl.kind) || sym.decl.kind === "struct") return value(sym.name, { file: this.at.file, ...(this.at.contract ? { contract: this.at.contract } : {}) });
      return undefined;
    }
    if (type.kind === "function") return this.returnsOf(type.sym);
    // Built-in member functions (`abi.encode`, `bytes.concat`).
    return builtinTypeOf(expr);
  }

  /** The single return type of a function, or the type read through a public getter. */
  returnsOf(sym: Sym): ExprType | undefined {
    const decl = sym.decl;
    if (decl.kind === "function") {
      const returns = decl.returns ?? [];
      return returns.length === 1 ? value(returns[0]!.type, this.resolver.declScope(sym)) : undefined;
    }
    if (!decl.type) return undefined;
    // Getter of a public mapping or array: the value type.
    let type = decl.type;
    while (type.startsWith("mapping(") || type.endsWith("]")) type = indexedType(type) ?? type;
    return value(type, this.resolver.declScope(sym));
  }

  /** The declaration of a user-defined value type (struct, contract, enum...), if any. */
  async typeSym(t: Extract<ExprType, { kind: "value" }>): Promise<Sym | undefined> {
    if (isElementaryType(t.type) || t.type.endsWith("]") || t.type.startsWith("mapping(") || t.type.startsWith("function")) return undefined;
    return this.resolver.resolvePath(t.at ?? this.at, t.type);
  }
}

function value(type: string, at?: TypeScope): ExprType {
  return at ? { kind: "value", type, at } : { kind: "value", type };
}

function builtinValueMember(type: string, name: string): ExprType | undefined {
  const member = valueMembers(type).find((b) => b.name === name);
  return member?.kind === "property" && member.type ? value(member.type) : undefined;
}
