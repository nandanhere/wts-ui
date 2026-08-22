import assert from "node:assert/strict";
import test from "node:test";
import { projectOrder } from "../src/projection.mjs";

test("the projection preserves normalized currency", () => {
  const projection = projectOrder({
    type: "OrderAccepted",
    orderId: "order-2",
    totalCents: 9900,
    currency: "USD",
    instance: "copy-1",
  });
  assert.equal(projection.currency, "USD");
});

test("the projection rejects a malformed supplied currency", () => {
  assert.throws(() =>
    projectOrder({
      type: "OrderAccepted",
      orderId: "order-2",
      totalCents: 9900,
      currency: "$",
      instance: "copy-1",
    }),
  );
});
