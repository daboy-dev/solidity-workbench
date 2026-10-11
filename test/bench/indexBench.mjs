// Benchmark: index a big project with the real worker, measuring event-loop lag.
// Usage: npm run build && node test/bench/indexBench.mjs <projectRoot> . <outFile.cjs>
import { createRequire } from "node:module";
import { build } from "esbuild";
const [root, repo, out] = process.argv.slice(2);
await build({ entryPoints: [`${repo}/test/bench/entry.ts`], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "error" });
const require = createRequire(import.meta.url);
const m = require(out);
let maxLag = 0, last = performance.now();
const t = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - last - 10); last = now; }, 10);
const project = await m.loadProject(root, { useForge: false });
const cacheFile = `${out}.cache.json`;
for (const label of ["cold", "warm(cache)"]) {
  maxLag = 0; last = performance.now();
  const parser = new m.WorkerFileParser(`${repo}/dist/indexWorker.js`, (e) => console.log("WORKER ERROR", e));
  const ix = new m.ProjectIndexer(project, m.DEFAULT_SCOPE, { parser, cacheFile });
  const stats = await ix.build();
  await ix.flushCache();
  console.log(label, JSON.stringify(stats), "maxEventLoopLagMs", maxLag.toFixed(1));
  const importer = `${root}/src/App.sol`;
  for (const prefix of ["O", "Own", "E"]) {
    const t0 = performance.now();
    const all = m.findImportCandidates({ project, index: ix.index, importerPath: importer, pathStyle: "remapped", nameFilter: m.subsequenceFilter(prefix) });
    const c = m.selectForCompletion(all, prefix, 400);
    console.log(`  query '${prefix}': ${all.length} matches, ${c.length} shown in ${(performance.now() - t0).toFixed(1)} ms; first Ownable ->`, c.find((x) => x.name === "Ownable")?.importPath);
  }
  parser.dispose();
}
clearInterval(t);
