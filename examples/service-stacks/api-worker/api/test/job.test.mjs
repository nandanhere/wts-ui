import assert from "node:assert/strict";
import test from "node:test";
import { normalizeJob } from "../src/job.mjs";

test("jobs default to the double operation", () => {
  assert.deepEqual(normalizeJob({ id: "job-1", input: 21 }), {
    id: "job-1",
    input: 21,
    operation: "double",
  });
});

test("jobs reject unsafe file names", () => {
  assert.throws(() => normalizeJob({ id: "../escape", input: 1 }));
});
