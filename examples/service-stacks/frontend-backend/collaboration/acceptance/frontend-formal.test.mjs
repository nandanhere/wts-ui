import assert from "node:assert/strict";
import test from "node:test";
import { greetingApiPath, renderGreeting } from "../src/client.mjs";

test("formal tone is sent to the backend", () => {
  assert.equal(
    greetingApiPath("Ada & Lin", "formal"),
    "/api/greeting?name=Ada+%26+Lin&tone=formal",
  );
});

test("the response tone is rendered safely", () => {
  assert.equal(
    renderGreeting({ message: "Welcome.", instance: "copy", tone: "formal" }),
    '<p data-instance="copy" data-tone="formal">Welcome.</p>',
  );
});
