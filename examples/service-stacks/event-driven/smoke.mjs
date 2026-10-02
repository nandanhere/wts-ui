import assert from "node:assert/strict";
import { requestJson } from "../lib/stack-runtime.mjs";

const commandPort = Number(process.env.COMMAND_API_PORT);
const readPort = Number(process.env.READ_API_PORT);
const projectorPort = Number(process.env.PROJECTOR_PORT);
const instanceId = process.env.WTS_INSTANCE_ID;
const orderId = `smoke-${instanceId}`;

const accepted = await requestJson({
  port: commandPort,
  method: "POST",
  requestPath: "/orders",
  body: { id: orderId, totalCents: 4250 },
});
assert.ok(accepted.status === 202 || accepted.status === 200);

const deadline = Date.now() + 4_000;
let order;
while (Date.now() < deadline) {
  const response = await requestJson({
    port: readPort,
    requestPath: `/orders/${orderId}`,
  });
  if (response.status === 200) {
    order = response.json;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 35));
}
assert.deepEqual(order, {
  id: orderId,
  totalCents: 4250,
  status: "accepted",
  instance: instanceId,
});

const projector = await requestJson({
  port: projectorPort,
  requestPath: "/health",
});
assert.equal(projector.status, 200);
assert.ok(projector.json.projected >= 1);

console.log("command, event projection, and read flow passed");
