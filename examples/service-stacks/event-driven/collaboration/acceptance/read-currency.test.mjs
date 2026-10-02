import assert from "node:assert/strict";
import test from "node:test";
import { publicOrder } from "../src/public-order.mjs";

test("the public order contains the allow-listed currency", () => {
  assert.equal(
    publicOrder({
      id: "order-2",
      totalCents: 9900,
      currency: "USD",
      status: "accepted",
      instance: "copy-1",
      internal: true,
    }).currency,
    "USD",
  );
});
