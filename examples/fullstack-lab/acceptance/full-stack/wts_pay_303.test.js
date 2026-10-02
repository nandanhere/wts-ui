import assert from "node:assert/strict";
import test from "node:test";

import { formatOrderTotal } from "../src/checkout.js";

test("PAY-303 formats the integer-cent API contract", () => {
  assert.equal(formatOrderTotal({ total_cents: 4_250 }), "$42.50");
});
