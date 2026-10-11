import { describe, expect, it } from "vitest";
import {
  mergeRemappings,
  parseRemapping,
  parseRemappingsText,
  relativeImport,
  resolveImport,
  toImportPath,
} from "../../src/core/project/remappings";

describe("parseRemapping", () => {
  it("parses prefix=target", () => {
    expect(parseRemapping("forge-std/=lib/forge-std/src/")).toEqual({
      context: "",
      prefix: "forge-std/",
      target: "lib/forge-std/src/",
    });
  });

  it("parses context:prefix=target and normalizes ./", () => {
    expect(parseRemapping("lib/a:@oz/=./lib/oz/contracts")).toEqual({
      context: "lib/a",
      prefix: "@oz/",
      target: "lib/oz/contracts/",
    });
  });

  it("ignores blank lines, comments and malformed entries", () => {
    expect(parseRemappingsText("\n# comment\nnoequals\n=x\nds-test/=lib/ds-test/src/\r\n")).toHaveLength(1);
  });
});

const remappings = parseRemappingsText(`
@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/
@openzeppelin/=lib/openzeppelin-contracts/
forge-std/=lib/forge-std/src/
lib/legacy:@openzeppelin/contracts/=lib/legacy/lib/oz-v4/contracts/
`);

describe("resolveImport", () => {
  it("uses the longest matching prefix", () => {
    expect(resolveImport(remappings, "@openzeppelin/contracts/access/Ownable.sol", "src/A.sol")).toBe(
      "lib/openzeppelin-contracts/contracts/access/Ownable.sol",
    );
  });

  it("prefers a matching context over a longer prefix without context", () => {
    expect(resolveImport(remappings, "@openzeppelin/contracts/access/Ownable.sol", "lib/legacy/src/X.sol")).toBe(
      "lib/legacy/lib/oz-v4/contracts/access/Ownable.sol",
    );
  });

  it("resolves relative imports against the importer", () => {
    expect(resolveImport(remappings, "../utils/Context.sol", "lib/oz/contracts/access/Ownable.sol")).toBe(
      "lib/oz/contracts/utils/Context.sol",
    );
  });
});

describe("toImportPath", () => {
  it("chooses the remapping with the longest target", () => {
    expect(toImportPath(remappings, "lib/openzeppelin-contracts/contracts/access/Ownable.sol", "src/Vault.sol")).toEqual({
      path: "@openzeppelin/contracts/access/Ownable.sol",
      remapping: remappings[0],
    });
  });

  it("falls back to a relative path when no remapping covers the file", () => {
    expect(toImportPath(remappings, "src/types/Types.sol", "src/Vault.sol").path).toBe("./types/Types.sol");
    expect(toImportPath(remappings, "src/Types.sol", "test/unit/Vault.t.sol").path).toBe("../../src/Types.sol");
  });

  it("uses a relative path when the style is relative", () => {
    expect(
      toImportPath(remappings, "lib/forge-std/src/Test.sol", "test/Vault.t.sol", "relative").path,
    ).toBe("../lib/forge-std/src/Test.sol");
  });

  it("respects remapping contexts of the importer", () => {
    expect(toImportPath(remappings, "lib/legacy/lib/oz-v4/contracts/access/Ownable.sol", "lib/legacy/src/A.sol").path).toBe(
      "@openzeppelin/contracts/access/Ownable.sol",
    );
    // Outside the context the same file is not reachable through that remapping.
    expect(toImportPath(remappings, "lib/legacy/lib/oz-v4/contracts/access/Ownable.sol", "src/A.sol").remapping).toBeUndefined();
  });

  it("rejects candidates that would resolve to a different file", () => {
    // `@openzeppelin/contracts/x.sol` would be captured by the longer prefix.
    const tricky = parseRemappingsText("@openzeppelin/=lib/oz/\n@openzeppelin/contracts/=lib/other/");
    expect(toImportPath(tricky, "lib/oz/contracts/x.sol", "src/A.sol").path).toBe("../lib/oz/contracts/x.sol");
  });
});

describe("relativeImport", () => {
  it("prefixes same-directory paths with ./", () => {
    expect(relativeImport("src/A.sol", "src/B.sol")).toBe("./B.sol");
  });
});

describe("mergeRemappings", () => {
  it("keeps the first remapping for a given context and prefix", () => {
    const merged = mergeRemappings(parseRemappingsText("a/=x/"), parseRemappingsText("a/=y/\nb/=z/"));
    expect(merged.map((r) => r.target)).toEqual(["x/", "z/"]);
  });
});
