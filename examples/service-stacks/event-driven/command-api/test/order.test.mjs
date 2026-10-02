import assert from "node:assert/strict";
import test from "node:test";
import { createOrderEvent } from "../src/order.mjs";

test("accepted orders become instance-scoped events", () => {
  assert.deepEqual(createOrderEvent({ id: "order-1", totalCents: 4250 }, "copy-1"), {
    type: "OrderAccepted",
    orderId: "order-1",
    totalCents: 4250,
    instance: "copy-1",
  });
});
