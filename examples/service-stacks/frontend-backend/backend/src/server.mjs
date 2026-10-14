import http from "node:http";
import { greetingPayload } from "./greeting.mjs";

const host = "127.0.0.1";
const port = Number(process.env.BACKEND_PORT);
const instanceId = process.env.WTS_INSTANCE_ID ?? "unknown";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("BACKEND_PORT must be an injected TCP port");
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      service: "backend",
      instance: instanceId,
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/greeting") {
    sendJson(response, 200, greetingPayload(url.searchParams.get("name"), instanceId));
    return;
  }
  sendJson(response, 404, { error: "not_found" });
});

server.listen(port, host, () => {
  console.log(`backend ready on ${host}:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 1_000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
