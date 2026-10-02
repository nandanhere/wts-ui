import assert from "node:assert/strict";
import test from "node:test";

import { checkoutButtonLabel } from "../src/checkout.js";

test("UI-101 uses the clearer checkout call to action", () => {
  assert.equal(checkoutButtonLabel(), "Place order");
});
