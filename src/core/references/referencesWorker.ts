import { parentPort } from "node:worker_threads";
import { handleAstRequest, type AstWorkerRequest } from "./astWorker";

// Entry point of the solc AST worker thread (bundled as dist/referencesWorker.js).
parentPort?.on("message", (req: AstWorkerRequest) => {
  void handleAstRequest(req, (res) => parentPort?.postMessage(res));
});
