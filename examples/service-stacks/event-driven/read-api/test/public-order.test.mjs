import assert from "node:assert/strict";
import test from "node:test";
import { publicOrder } from "../src/public-order.mjs";

test("the read API exposes a stable public shape", () => {
  assert.deepEqual(
    publicOrder({
      id: "order-1",
      totalCents: 4250,
      status: "accepted",
      instance: "copy-1",
      internal: "hidden",
    }),
    {
      id: "order-1",
      totalCents: 4250,
      status: "accepted",
      instance: "copy-1",
    },
  );
});
