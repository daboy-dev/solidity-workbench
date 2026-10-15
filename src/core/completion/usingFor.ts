import { accepts, isBuiltinType, lastName, normalize, type Receiver } from "./calls";
import type { UsingDirective } from "./structure";
import type { SymbolResolver, Sym, TypeScope } from "./symbols";

/**
 * Functions attached to `receiver` with `using ... for` as seen from `at`: directives of
 * the enclosing contract (not of its bases), of the file, and `global` ones of the file
 * declaring the type. Only functions whose first parameter accepts the value are kept,
 * as solc does. With `name`, only functions of that name (every overload).
 */
export async function attachedFunctions(resolver: SymbolResolver, at: TypeScope, receiver: Receiver, name?: string): Promise<Sym[]> {
  const directives: Array<{ directive: UsingDirective; scope: TypeScope }> = [];
  for (const directive of at.contract?.usings ?? []) directives.push({ directive, scope: at });
  for (const directive of at.file.structure.usings) directives.push({ directive, scope: { file: at.file } });
  const home = receiver.sym?.file;
  if (home && home.path !== at.file.path) {
    for (const directive of home.structure.usings) if (directive.global) directives.push({ directive, scope: { file: home } });
  }

  const out: Sym[] = [];
  for (const { directive, scope } of directives) {
    if (!(await targetMatches(resolver, scope, directive.target, receiver))) continue;
    for (const fn of await functionsOf(resolver, scope, directive, name)) {
      if (out.some((s) => s.decl === fn.decl)) continue;
      const first = fn.decl.params?.[0];
      if (first && (await accepts(resolver, receiver, first.type, resolver.declScope(fn)))) out.push(fn);
    }
  }
  return out;
}

/** The functions a directive attaches (before checking their first parameter). */
async function functionsOf(resolver: SymbolResolver, scope: TypeScope, directive: UsingDirective, name: string | undefined): Promise<Sym[]> {
  const named = (s: Sym) => s.decl.kind === "function" && (name === undefined || s.name === name);
  if (directive.library) {
    const lib = await resolver.resolvePath(scope, directive.library, false);
    const node = lib && resolver.contractOf(lib);
    if (!lib || !node) return [];
    return node.members.filter((d) => d.visibility !== "private").map((decl): Sym => ({ name: decl.name, decl, file: lib.file, owner: node })).filter(named);
  }
  const out: Sym[] = [];
  for (const path of directive.functions ?? []) {
    const parts = path.split(".");
    const last = parts.at(-1)!;
    if (name !== undefined && last !== name) continue;
    if (parts.length === 1) {
      out.push(...((await resolver.fileScope(scope.file)).get(last) ?? []).filter(named));
      continue;
    }
    const owner = await resolver.resolvePath(scope, parts.slice(0, -1).join("."), false);
    if (!owner) continue;
    if (owner.module) {
      out.push(...((await resolver.fileScope(owner.module)).get(last) ?? []).filter(named));
      continue;
    }
    const node = resolver.contractOf(owner);
    if (node) out.push(...node.members.filter((d) => d.name === last).map((decl): Sym => ({ name: decl.name, decl, file: owner.file, owner: node })).filter(named));
  }
  return out;
}

/** Whether `using ... for target` (written in `scope`) applies to the receiver's type. */
async function targetMatches(resolver: SymbolResolver, scope: TypeScope, target: string, receiver: Receiver): Promise<boolean> {
  if (target === "*") return true;
  if (isBuiltinType(target) || isBuiltinType(receiver.type)) return normalize(target) === normalize(receiver.type);
  const sym = await resolver.resolvePath(scope, target);
  if (sym && receiver.sym) return sym.decl === receiver.sym.decl;
  return lastName(target) === lastName(receiver.type);
}
