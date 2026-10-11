import { describe, expect, it } from "vitest";
import { blankTrivia, isInCommentOrString, scanTrivia } from "../../src/core/solidity/lexContext";

/** `|` marks the cursor. */
function at(src: string): boolean {
  const offset = src.indexOf("|");
  const text = src.slice(0, offset) + src.slice(offset + 1);
  return isInCommentOrString(scanTrivia(text), offset);
}

describe("isInCommentOrString", () => {
  it("detects line comments, including at end of line", () => {
    expect(at("// Ownab|\ncontract A {}")).toBe(true);
    expect(at("uint a; // Own|")).toBe(true);
    expect(at("// x\nOwn|")).toBe(false);
  });

  it("detects block comments and NatSpec", () => {
    expect(at("/** @dev uses Own| */")).toBe(true);
    expect(at("/* x */ Own|")).toBe(false);
    expect(at("/* unterminated Own|")).toBe(true);
  });

  it("detects strings with both quote styles and escapes", () => {
    expect(at('string s = "Own|";')).toBe(true);
    expect(at("string s = 'a\\'Own|';")).toBe(true);
    expect(at('string s = "x"; Own|')).toBe(false);
    expect(at('string s = "unterminated Own|')).toBe(true);
  });

  it("does not treat // inside strings as a comment", () => {
    expect(at('string u = "https://x"; Own|')).toBe(false);
  });

  it("is outside at the very start of a comment", () => {
    expect(at("|// c")).toBe(false);
  });
});

describe("blankTrivia", () => {
  it("preserves offsets and newlines", () => {
    const src = 'a /* b\nc */ "d" // e\nf';
    const out = blankTrivia(src);
    expect(out.length).toBe(src.length);
    expect(out).toBe('a     \n     " "     \nf');
  });
});
