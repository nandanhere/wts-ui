import assert from "node:assert/strict";
import test from "node:test";
import { projectOrder } from "../src/projection.mjs";

test("order events become query projections", () => {
  assert.deepEqual(
    projectOrder({
      type: "OrderAccepted",
      orderId: "order-1",
      totalCents: 4250,
      instance: "copy-1",
    }),
    {
      id: "order-1",
      totalCents: 4250,
      status: "accepted",
      instance: "copy-1",
    },
  );
});
