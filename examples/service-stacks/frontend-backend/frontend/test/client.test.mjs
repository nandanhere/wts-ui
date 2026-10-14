import assert from "node:assert/strict";
import test from "node:test";
import { greetingApiPath, renderGreeting } from "../src/client.mjs";

test("client path encodes untrusted names", () => {
  assert.equal(greetingApiPath("Ada & Lin"), "/api/greeting?name=Ada+%26+Lin");
});

test("rendered greetings escape service data", () => {
  assert.equal(
    renderGreeting({ message: "<hello>", instance: '"copy"' }),
    '<p data-instance="&quot;copy&quot;">&lt;hello&gt;</p>',
  );
});
