import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/core/solidity/fileAnalysis";
import { computeImportEdit, type ImportRequest } from "../../src/core/solidity/importEdit";

const OZ = "@openzeppelin/contracts/access/Ownable.sol";

/** Applies the edit for `request` to `src` and returns the new text. */
function apply(src: string, request: ImportRequest): string {
  const edit = computeImportEdit(analyzeFile(src), request);
  return edit ? src.slice(0, edit.start) + edit.newText + src.slice(edit.end) : src;
}

const ownable: ImportRequest = { name: "Ownable", path: OZ };

describe("computeImportEdit: new import line", () => {
  it("goes after the last import", () => {
    const src = `pragma solidity ^0.8.20;

import {A} from "./A.sol";
import {B} from "./B.sol"; // trailing comment

contract C {}
`;
    expect(apply(src, ownable)).toBe(`pragma solidity ^0.8.20;

import {A} from "./A.sol";
import {B} from "./B.sol"; // trailing comment
import {Ownable} from "${OZ}";

contract C {}
`);
  });

  it("goes after the pragma with a blank line on both sides", () => {
    const src = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Vault is Ownable {}
`;
    expect(apply(src, ownable)).toBe(`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "${OZ}";

contract Vault is Ownable {}
`);
  });

  it("does not add extra blank lines when one already follows the pragma", () => {
    const src = `pragma solidity ^0.8.20;\n\ncontract Vault {}\n`;
    expect(apply(src, ownable)).toBe(`pragma solidity ^0.8.20;\n\nimport {Ownable} from "${OZ}";\n\ncontract Vault {}\n`);
  });

  it("goes after the last of several pragmas", () => {
    const src = `pragma solidity ^0.8.20;\npragma abicoder v2;\n\ncontract X {}\n`;
    expect(apply(src, ownable)).toBe(`pragma solidity ^0.8.20;\npragma abicoder v2;\n\nimport {Ownable} from "${OZ}";\n\ncontract X {}\n`);
  });

  it("goes after the SPDX line when there is no pragma", () => {
    const src = `// SPDX-License-Identifier: MIT\ncontract X {}\n`;
    expect(apply(src, ownable)).toBe(`// SPDX-License-Identifier: MIT\n\nimport {Ownable} from "${OZ}";\n\ncontract X {}\n`);
  });

  it("goes first in a file without header", () => {
    expect(apply("contract X {}\n", ownable)).toBe(`import {Ownable} from "${OZ}";\n\ncontract X {}\n`);
    expect(apply("", ownable)).toBe(`import {Ownable} from "${OZ}";\n`);
  });

  it("follows the file's quote style", () => {
    const src = `pragma solidity ^0.8.20;\nimport {A} from './A.sol';\n`;
    expect(apply(src, ownable)).toBe(`pragma solidity ^0.8.20;\nimport {A} from './A.sol';\nimport {Ownable} from '${OZ}';\n`);
  });

  it("keeps CRLF line endings", () => {
    const src = `pragma solidity ^0.8.20;\r\nimport {A} from "./A.sol";\r\n\r\ncontract C {}\r\n`;
    expect(apply(src, ownable)).toBe(`pragma solidity ^0.8.20;\r\nimport {A} from "./A.sol";\r\nimport {Ownable} from "${OZ}";\r\n\r\ncontract C {}\r\n`);
  });

  it("ignores imports inside comments", () => {
    const src = `pragma solidity ^0.8.20;\n// import {Ownable} from "${OZ}";\ncontract C {}\n`;
    expect(apply(src, ownable)).toContain(`\n\nimport {Ownable} from "${OZ}";\n`);
  });

  it("does not merge into plain or aliased imports of the same file", () => {
    const src = `pragma solidity ^0.8.20;\nimport * as OZ from "${OZ}";\n`;
    expect(apply(src, ownable)).toBe(`${src}import {Ownable} from "${OZ}";\n`);
  });
});

describe("computeImportEdit: merging", () => {
  it("merges into a single-line named import of the same path", () => {
    const src = `pragma solidity ^0.8.20;\nimport {Context} from "${OZ}";\n`;
    expect(apply(src, ownable)).toBe(`pragma solidity ^0.8.20;\nimport {Context, Ownable} from "${OZ}";\n`);
  });

  it("keeps the spacing style inside braces", () => {
    const src = `import { Context } from "${OZ}";\n`;
    expect(apply(src, ownable)).toBe(`import { Context, Ownable } from "${OZ}";\n`);
  });

  it("merges into multi-line imports, with or without trailing comma", () => {
    const multi = `import {\n    Context,\n    Foo\n} from "${OZ}";\n`;
    expect(apply(multi, ownable)).toBe(`import {\n    Context,\n    Foo,\n    Ownable\n} from "${OZ}";\n`);
    const trailing = `import {\n    Context,\n} from "${OZ}";\n`;
    expect(apply(trailing, ownable)).toBe(`import {\n    Context,\n    Ownable,\n} from "${OZ}";\n`);
  });

  it("fills empty braces", () => {
    expect(apply(`import {} from "${OZ}";\n`, ownable)).toBe(`import {Ownable} from "${OZ}";\n`);
  });

  it("merges when the existing path is a different spelling of the same file", () => {
    const src = `import {Context} from "../lib/oz/contracts/access/Ownable.sol";\n`;
    const out = apply(src, { ...ownable, samePath: (p) => p === "../lib/oz/contracts/access/Ownable.sol" });
    expect(out).toBe(`import {Context, Ownable} from "../lib/oz/contracts/access/Ownable.sol";\n`);
  });

  it("does nothing when the symbol is already imported from that file", () => {
    const src = `import {Ownable} from "${OZ}";\n`;
    expect(computeImportEdit(analyzeFile(src), ownable)).toBeUndefined();
  });

  it("adds the plain name next to an aliased import of it", () => {
    const src = `import {Ownable as OZOwnable} from "${OZ}";\n`;
    expect(apply(src, ownable)).toBe(`import {Ownable as OZOwnable, Ownable} from "${OZ}";\n`);
  });

  it("merges two consecutive requests into a single import", () => {
    const src = `pragma solidity ^0.8.20;\n\ncontract C {}\n`;
    const once = apply(src, { name: "Position", path: "./Types.sol" });
    const twice = apply(once, { name: "Side", path: "./Types.sol" });
    expect(twice).toBe(`pragma solidity ^0.8.20;\n\nimport {Position, Side} from "./Types.sol";\n\ncontract C {}\n`);
  });
});
