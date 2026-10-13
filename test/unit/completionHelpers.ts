import { complete, type CompletionEntry, type CompletionEnv } from "../../src/core/completion/complete";
import { cursorContext, type CursorContext } from "../../src/core/completion/cursorContext";
import { parseStructure } from "../../src/core/completion/structure";

/** Cursor context at the `|` marker of `source` (the marker is removed). */
export function at(source: string): CursorContext {
  const offset = source.indexOf("|");
  if (offset < 0) throw new Error("no | marker");
  const text = source.slice(0, offset) + source.slice(offset + 1);
  return cursorContext(parseStructure(text), offset);
}

export async function entries(source: string, env: Partial<CompletionEnv> = {}): Promise<CompletionEntry[]> {
  return complete(at(source), { version: "0.8.30", ...env });
}

export async function labels(source: string, env: Partial<CompletionEnv> = {}): Promise<string[]> {
  return (await entries(source, env)).map((e) => e.label);
}

/** Wraps statements in a function body. */
export function inBody(body: string, header = "function f(address a, uint256 n) external"): string {
  return `pragma solidity ^0.8.20;\ncontract C {\n    ${header} {\n        ${body}\n    }\n}\n`;
}
