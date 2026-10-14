import http from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { publicOrder } from "./public-order.mjs";

const host = "127.0.0.1";
const port = Number(process.env.READ_API_PORT);
const instanceId = process.env.WTS_INSTANCE_ID ?? "unknown";
const stateDirectory = path.resolve(process.env.WTS_STATE_DIR ?? "");
const projectionsDirectory = path.join(stateDirectory, "projections");

if (!Number.isInteger(port) || port < 1 || port > 65535 || !process.env.WTS_STATE_DIR) {
  throw new Error("READ_API_PORT and WTS_STATE_DIR must be injected");
}
await mkdir(projectionsDirectory, { recursive: true });

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      service: "read-api",
      instance: instanceId,
    });
    return;
  }
  const match = request.method === "GET" && url.pathname.match(/^\/orders\/([a-zA-Z0-9_-]+)$/);
  if (match) {
    try {
      const projection = JSON.parse(
        await readFile(path.join(projectionsDirectory, `${match[1]}.json`), "utf8"),
      );
      sendJson(response, 200, publicOrder(projection));
    } catch (error) {
      if (error.code === "ENOENT") {
        sendJson(response, 404, { error: "not_projected" });
      } else {
        sendJson(response, 500, { error: "projection_unavailable" });
      }
    }
    return;
  }
  sendJson(response, 404, { error: "not_found" });
});

server.listen(port, host, () => {
  console.log(`read API ready on ${host}:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 1_000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
