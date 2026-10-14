import assert from "node:assert/strict";
import test from "node:test";
import { createOrderEvent } from "../src/order.mjs";

test("commands normalize currency into the event contract", () => {
  assert.equal(
    createOrderEvent({ id: "order-2", totalCents: 9900, currency: "usd" }, "copy-1").currency,
    "USD",
  );
});

test("commands reject malformed currency", () => {
  assert.throws(() =>
    createOrderEvent({ id: "order-2", totalCents: 9900, currency: "$" }, "copy-1"),
  );
});
