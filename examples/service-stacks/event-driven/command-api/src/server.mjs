import http from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createOrderEvent } from "./order.mjs";

const host = "127.0.0.1";
const port = Number(process.env.COMMAND_API_PORT);
const instanceId = process.env.WTS_INSTANCE_ID ?? "unknown";
const stateDirectory = path.resolve(process.env.WTS_STATE_DIR ?? "");
const eventsDirectory = path.join(stateDirectory, "events");

if (!Number.isInteger(port) || port < 1 || port > 65535 || !process.env.WTS_STATE_DIR) {
  throw new Error("COMMAND_API_PORT and WTS_STATE_DIR must be injected");
}
await mkdir(eventsDirectory, { recursive: true });

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        request.destroy(new Error("request body is too large"));
      } else {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("request body is not JSON"));
      }
    });
    request.on("error", reject);
  });
}

async function appendEvent(event) {
  const target = path.join(eventsDirectory, `${event.orderId}.json`);
  try {
    const existing = JSON.parse(await readFile(target, "utf8"));
    return { created: false, event: existing };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(event)}\n`, { flag: "wx" });
  await rename(temporary, target);
  return { created: true, event };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      service: "command-api",
      instance: instanceId,
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/orders") {
    try {
      const result = await appendEvent(createOrderEvent(await readJsonBody(request), instanceId));
      sendJson(response, result.created ? 202 : 200, result);
    } catch {
      sendJson(response, 400, { error: "invalid_order" });
    }
    return;
  }
  sendJson(response, 404, { error: "not_found" });
});

server.listen(port, host, () => {
  console.log(`command API ready on ${host}:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 1_000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
