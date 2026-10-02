import assert from "node:assert/strict";
import { requestJson } from "../lib/stack-runtime.mjs";

const apiPort = Number(process.env.JOBS_API_PORT);
const workerPort = Number(process.env.JOBS_WORKER_PORT);
const instanceId = process.env.WTS_INSTANCE_ID;
const jobId = `smoke-${instanceId}`;

const submitted = await requestJson({
  port: apiPort,
  method: "POST",
  requestPath: "/jobs",
  body: { id: jobId, input: 21 },
});
assert.ok(submitted.status === 202 || submitted.status === 200);

const deadline = Date.now() + 4_000;
let job;
while (Date.now() < deadline) {
  const response = await requestJson({
    port: apiPort,
    requestPath: `/jobs/${jobId}`,
  });
  if (response.status === 200 && response.json.status === "complete") {
    job = response.json.job;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 35));
}
assert.ok(job, "job did not complete before the smoke timeout");
assert.equal(job.output, 42);
assert.equal(job.instance, instanceId);

const worker = await requestJson({
  port: workerPort,
  requestPath: "/health",
});
assert.equal(worker.status, 200);
assert.equal(worker.json.instance, instanceId);
assert.ok(worker.json.processed >= 1);

console.log("API and worker asynchronous flow passed");
