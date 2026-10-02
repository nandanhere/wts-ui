import assert from "node:assert/strict";
import test from "node:test";
import { processJob } from "../src/processor.mjs";

test("the worker executes square jobs", () => {
  assert.equal(processJob({ id: "square-1", input: 9, operation: "square" }).output, 81);
});

test("the worker rejects unknown operations", () => {
  assert.throws(() => processJob({ id: "bad-1", input: 9, operation: "erase" }));
});
