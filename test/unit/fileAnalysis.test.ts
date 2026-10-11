import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/core/solidity/fileAnalysis";

describe("analyzeFile", () => {
  const src = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
pragma abicoder v2;

import {A, B as Bee} from "./AB.sol";
import './Plain.sol';
import * as Lib from "lib/Lib.sol";
import "unit.sol" as Unit;
import {
    Multi,
    Line
} from "multi.sol";

// import {Commented} from "x.sol";
contract Local is A {
    struct Inner { uint x; }
    function f() public { string memory s = "import {Fake} from 'y';"; }
}
error LocalError();
`;
  const a = analyzeFile(src);

  it("finds every import statement with its kind", () => {
    expect(a.imports.map((i) => [i.kind, i.path])).toEqual([
      ["named", "./AB.sol"],
      ["plain", "./Plain.sol"],
      ["unitAlias", "lib/Lib.sol"],
      ["unitAlias", "unit.sol"],
      ["named", "multi.sol"],
    ]);
    expect(a.imports[0]!.symbols).toEqual([{ name: "A" }, { name: "B", alias: "Bee" }]);
    expect(a.imports[2]!.unitAlias).toBe("Lib");
    expect(a.imports[3]!.unitAlias).toBe("Unit");
    expect(a.imports[4]!.symbols.map((s) => s.name)).toEqual(["Multi", "Line"]);
  });

  it("collects names in scope", () => {
    expect([...a.importedNames].sort()).toEqual(["A", "Bee", "Lib", "Line", "Multi", "Unit"]);
    expect([...a.declaredNames].sort()).toEqual(["Local", "LocalError"]);
  });

  it("locates the header", () => {
    expect(src.slice(0, a.pragmaEnd)).toMatch(/pragma abicoder v2;$/);
    expect(src.slice(0, a.spdxEnd)).toBe("// SPDX-License-Identifier: MIT");
  });

  it("detects the dominant quote style", () => {
    expect(a.preferredQuote).toBe('"');
    expect(analyzeFile("import {A} from 'a.sol';\nimport 'b.sol';").preferredQuote).toBe("'");
    expect(analyzeFile("contract C {}").preferredQuote).toBe('"');
  });

  it("tolerates incomplete code", () => {
    const partial = analyzeFile('pragma solidity ^0.8.0;\nimport {A} from "a.sol";\nimport {B} from "b\ncontract C is Own');
    expect(partial.imports.map((i) => i.path)).toEqual(["a.sol"]);
  });
});
