import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

describe("packaging", () => {
  it("ships every bundle built into dist/ (workers included)", () => {
    const build = fs.readFileSync(path.join(ROOT, "esbuild.mjs"), "utf8");
    const entries = build.slice(build.indexOf("entryPoints: {"), build.indexOf("outdir: \"dist\""));
    const bundles = [...entries.matchAll(/^\s+(\w+): "src\//gm)].map((m) => m[1]);
    expect(bundles).toContain("referencesWorker");
    const ignore = fs.readFileSync(path.join(ROOT, ".vscodeignore"), "utf8").split("\n");
    for (const b of bundles) expect(ignore).toContain(`!dist/${b}.js`);
  });
});
