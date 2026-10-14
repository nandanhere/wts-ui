import assert from "node:assert/strict";
import { requestJson } from "../../lib/stack-runtime.mjs";

const frontendPort = Number(process.env.FRONTEND_PORT);
const response = await requestJson({
  port: frontendPort,
  requestPath: "/api/greeting?name=Ada&tone=formal",
});
assert.equal(response.status, 200);
assert.deepEqual(response.json, {
  message: "Welcome, Ada.",
  instance: process.env.WTS_INSTANCE_ID,
  tone: "formal",
});

console.log("parallel frontend/backend change integrated");
