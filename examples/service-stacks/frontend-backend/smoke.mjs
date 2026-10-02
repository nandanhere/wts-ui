import assert from "node:assert/strict";
import { requestJson } from "../lib/stack-runtime.mjs";

const frontendPort = Number(process.env.FRONTEND_PORT);
const instanceId = process.env.WTS_INSTANCE_ID;

const health = await requestJson({
  port: frontendPort,
  requestPath: "/health",
});
assert.equal(health.status, 200);
assert.deepEqual(health.json.dependencies, { backend: "ok" });
assert.equal(health.json.instance, instanceId);

const greeting = await requestJson({
  port: frontendPort,
  requestPath: "/api/greeting?name=Ada",
});
assert.equal(greeting.status, 200);
assert.equal(greeting.json.message, "Hello, Ada!");
assert.equal(greeting.json.instance, instanceId);

console.log("frontend and backend contract passed");
