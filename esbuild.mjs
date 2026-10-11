import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const withTests = process.argv.includes("--tests");

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  external: ["vscode"],
};

const builds = [
  {
    ...common,
    entryPoints: {
      extension: "src/extension.ts",
      indexWorker: "src/core/index/indexWorker.ts",
    },
    outdir: "dist",
  },
];

if (withTests) {
  builds.push({
    ...common,
    sourcemap: true,
    minify: false,
    external: ["vscode", "mocha"],
    entryPoints: {
      runTests: "test/integration/runTests.ts",
      "suite/index": "test/integration/suite/index.ts",
      "suite/autoImport.test": "test/integration/suite/autoImport.test.ts",
      "suite/extras.test": "test/integration/suite/extras.test.ts",
    },
    outdir: "out/integration",
  });
}

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
