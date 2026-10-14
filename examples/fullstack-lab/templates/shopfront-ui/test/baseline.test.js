import assert from "node:assert/strict";
import test from "node:test";

import { checkoutButtonLabel } from "../src/orders.js";

test("the checkout action always has a visible label", () => {
  assert.ok(checkoutButtonLabel().length > 0);
});
