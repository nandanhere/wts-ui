import assert from "node:assert/strict";
import { requestJson } from "../../lib/stack-runtime.mjs";

const commandPort = Number(process.env.COMMAND_API_PORT);
const readPort = Number(process.env.READ_API_PORT);
const id = `currency-${process.env.WTS_INSTANCE_ID}`;
const accepted = await requestJson({
  port: commandPort,
  method: "POST",
  requestPath: "/orders",
  body: { id, totalCents: 9900, currency: "usd" },
});
assert.equal(accepted.status, 202);

const deadline = Date.now() + 4_000;
while (Date.now() < deadline) {
  const response = await requestJson({ port: readPort, requestPath: `/orders/${id}` });
  if (response.status === 200) {
    assert.equal(response.json.currency, "USD");
    console.log("three parallel event-contract changes integrated");
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 35));
}
throw new Error("currency projection did not become visible");
