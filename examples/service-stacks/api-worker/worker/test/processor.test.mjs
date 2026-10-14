import assert from "node:assert/strict";
import test from "node:test";
import { processJob } from "../src/processor.mjs";

test("the worker doubles a job input", () => {
  assert.deepEqual(processJob({ id: "job-1", input: 21, operation: "double" }), {
    id: "job-1",
    input: 21,
    operation: "double",
    output: 42,
  });
});
