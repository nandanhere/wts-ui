import assert from "node:assert/strict";
import test from "node:test";
import { greetingPayload } from "../src/greeting.mjs";

test("greeting payload is deterministic and instance-scoped", () => {
  assert.deepEqual(greetingPayload("Ada", "copy-2"), {
    message: "Hello, Ada!",
    instance: "copy-2",
  });
});
