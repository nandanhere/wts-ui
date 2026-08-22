import assert from "node:assert/strict";
import { requestJson } from "../../lib/stack-runtime.mjs";

const apiPort = Number(process.env.JOBS_API_PORT);
const id = `square-${process.env.WTS_INSTANCE_ID}`;
const submitted = await requestJson({
  port: apiPort,
  method: "POST",
  requestPath: "/jobs",
  body: { id, input: 9, operation: "square" },
});
assert.equal(submitted.status, 202);

const deadline = Date.now() + 4_000;
while (Date.now() < deadline) {
  const response = await requestJson({ port: apiPort, requestPath: `/jobs/${id}` });
  if (response.json?.status === "complete") {
    assert.equal(response.json.job.operation, "square");
    assert.equal(response.json.job.output, 81);
    console.log("parallel API/worker change integrated");
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 35));
}
throw new Error("square job did not complete");
