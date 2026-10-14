import assert from "node:assert/strict";
import test from "node:test";
import { normalizeJob } from "../src/job.mjs";

test("the API preserves the square operation", () => {
  assert.deepEqual(normalizeJob({ id: "square-1", input: 9, operation: "square" }), {
    id: "square-1",
    input: 9,
    operation: "square",
  });
});

test("the API rejects unknown operations", () => {
  assert.throws(() => normalizeJob({ id: "bad-1", input: 9, operation: "erase" }));
});
