import { parentPort } from "node:worker_threads";
import { parseFile, type WorkerRequest, type WorkerResponse } from "./fileParser";

// Entry point of the indexing worker thread (bundled as dist/indexWorker.js).
parentPort?.on("message", async (req: WorkerRequest) => {
  const results = [];
  for (const p of req.paths) results.push(await parseFile(p));
  parentPort?.postMessage({ id: req.id, results } satisfies WorkerResponse);
});
