import { parentPort } from "node:worker_threads";
import { runTask, type WorkerRequest, type WorkerResponse } from "./fileParser";

// Entry point of the parsing worker thread (bundled as dist/indexWorker.js).
parentPort?.on("message", async (req: WorkerRequest) => {
  parentPort?.postMessage({ id: req.id, result: await runTask(req.task) } satisfies WorkerResponse);
});
