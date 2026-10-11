import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFoundryConfig } from "../../src/core/project/foundryConfig";
import { findProjectRoot, loadProject } from "../../src/core/project/projectModel";
import { loadRemappings } from "../../src/core/project/remappingSource";
import { formatRemapping } from "../../src/core/project/remappings";

const FIXTURE = path.resolve(__dirname, "../fixtures/foundry-project");

describe("parseFoundryConfig", () => {
  it("reads directories and remappings from the default profile", () => {
    const cfg = parseFoundryConfig(`
[profile.default]
src = "contracts/"
test = "./tests"
libs = ["lib", "node_modules"]
remappings = ["@oz/=lib/oz/contracts/"]
`);
    expect(cfg.src).toBe("contracts");
    expect(cfg.test).toBe("tests");
    expect(cfg.script).toBe("script");
    expect(cfg.libs).toEqual(["lib", "node_modules"]);
    expect(cfg.remappings.map(formatRemapping)).toEqual(["@oz/=lib/oz/contracts/"]);
  });

  it("overlays the active profile", () => {
    const cfg = parseFoundryConfig(`[profile.default]\nsrc = "a"\n[profile.ci]\nsrc = "b"\n`, "ci");
    expect(cfg.src).toBe("b");
  });

  it("falls back to defaults on invalid TOML", () => {
    expect(parseFoundryConfig("[[[").src).toBe("src");
  });
});

describe("loadRemappings", () => {
  it("uses forge output when available, relativizing absolute targets", async () => {
    const loaded = await loadRemappings(FIXTURE, parseFoundryConfig(""), {
      exec: async () => `@x/=${FIXTURE}/lib/x/\nforge-std/=lib/forge-std/src/\n`,
    });
    expect(loaded.origin).toBe("forge");
    expect(loaded.remappings.map(formatRemapping)).toEqual(["@x/=lib/x/", "forge-std/=lib/forge-std/src/"]);
  });

  it("falls back to files and forge-style inference when forge is missing", async () => {
    const loaded = await loadRemappings(FIXTURE, parseFoundryConfig(""), {
      exec: async () => {
        throw new Error("spawn forge ENOENT");
      },
    });
    expect(loaded.origin).toBe("files");
    expect(loaded.forgeError).toContain("ENOENT");
    const lines = loaded.remappings.map(formatRemapping);
    // From remappings.txt.
    expect(lines).toContain("forge-std/=lib/forge-std/src/");
    // Declared by the library's own remappings.txt, rebased onto the project.
    expect(lines).toContain("@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/");
    // Inferred from lib/<name>/src.
    expect(lines).toContain("solmate-lite/=lib/solmate-lite/src/");
    // The shallow copy wins over the nested lib/solmate-lite/lib/openzeppelin-contracts.
    expect(lines).toContain("openzeppelin-contracts/=lib/openzeppelin-contracts/contracts/");
    expect(lines).not.toContain("openzeppelin-contracts/=lib/solmate-lite/lib/openzeppelin-contracts/contracts/");
  });
});

describe("ProjectModel", () => {
  it("finds the nearest foundry.toml and maps files to import paths", async () => {
    const vault = path.join(FIXTURE, "src/Vault.sol");
    expect(await findProjectRoot(vault, path.dirname(FIXTURE))).toBe(FIXTURE);

    const project = await loadProject(FIXTURE, { useForge: false });
    const ownable = path.join(FIXTURE, "lib/openzeppelin-contracts/contracts/access/Ownable.sol");
    expect(project.importPathFor(ownable, vault, "remapped").path).toBe("@openzeppelin/contracts/access/Ownable.sol");
    expect(project.importPathFor(path.join(FIXTURE, "src/Types.sol"), vault, "remapped").path).toBe("./Types.sol");
    expect(project.areaOf(ownable)).toBe("lib");
    expect(project.areaOf(path.join(FIXTURE, "test/Vault.t.sol"))).toBe("test");
  });
});

describe("findProjectRoot", () => {
  it("does not treat a library's own foundry.toml as a separate project", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sw-root-"));
    try {
      await fs.mkdir(path.join(tmp, "app/lib/dep/src"), { recursive: true });
      await fs.mkdir(path.join(tmp, "app/packages/core/src"), { recursive: true });
      await fs.writeFile(path.join(tmp, "app/foundry.toml"), "[profile.default]\n");
      await fs.writeFile(path.join(tmp, "app/lib/dep/foundry.toml"), "[profile.default]\n");
      await fs.writeFile(path.join(tmp, "app/packages/core/foundry.toml"), "[profile.default]\n");
      const app = path.join(tmp, "app");
      expect(await findProjectRoot(path.join(app, "lib/dep/src/A.sol"), tmp)).toBe(app);
      // A nested project that is not a dependency (monorepo) is its own project.
      expect(await findProjectRoot(path.join(app, "packages/core/src/A.sol"), tmp)).toBe(path.join(app, "packages/core"));
      expect(await findProjectRoot(path.join(tmp, "Loose.sol"), tmp)).toBeUndefined();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
