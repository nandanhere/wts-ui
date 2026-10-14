import assert from "node:assert/strict";
import test from "node:test";
import { greetingPayload } from "../src/greeting.mjs";

test("formal greetings follow the versioned collaboration contract", () => {
  assert.deepEqual(greetingPayload("Ada", "copy-3", "formal"), {
    message: "Welcome, Ada.",
    instance: "copy-3",
    tone: "formal",
  });
});
