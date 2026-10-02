import http from "node:http";
import { greetingApiPath } from "./client.mjs";

const host = "127.0.0.1";
const port = Number(process.env.FRONTEND_PORT);
const backendPort = Number(process.env.BACKEND_PORT);
const instanceId = process.env.WTS_INSTANCE_ID ?? "unknown";

if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  !Number.isInteger(backendPort) ||
  backendPort < 1 ||
  backendPort > 65535
) {
  throw new Error("FRONTEND_PORT and BACKEND_PORT must be injected TCP ports");
}

function send(response, status, contentType, body) {
  const bytes = Buffer.from(body);
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": bytes.length,
    "cache-control": "no-store",
  });
  response.end(bytes);
}

function upstreamJson(requestPath, timeoutMs = 400) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host, port: backendPort, path: requestPath, timeout: timeoutMs },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size <= 64 * 1024) {
            chunks.push(chunk);
          } else {
            request.destroy(new Error("backend response exceeded fixture limit"));
          }
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({ status: response.statusCode ?? 502, body });
        });
      },
    );
    request.once("timeout", () => request.destroy(new Error("backend timed out")));
    request.once("error", reject);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.method === "GET" && url.pathname === "/health") {
    try {
      const backend = await upstreamJson("/health");
      const body = JSON.parse(backend.body.toString("utf8"));
      if (backend.status === 200 && body.status === "ok") {
        send(
          response,
          200,
          "application/json",
          JSON.stringify({
            status: "ok",
            service: "frontend",
            instance: instanceId,
            dependencies: { backend: "ok" },
          }),
        );
        return;
      }
    } catch {
      // A dependency-aware non-200 response lets the runner keep polling.
    }
    send(
      response,
      503,
      "application/json",
      JSON.stringify({ status: "degraded", dependencies: { backend: "unavailable" } }),
    );
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/greeting") {
    try {
      const upstream = await upstreamJson(greetingApiPath(url.searchParams.get("name") ?? ""));
      send(response, upstream.status, "application/json", upstream.body);
    } catch {
      send(response, 502, "application/json", JSON.stringify({ error: "backend_unavailable" }));
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    send(
      response,
      200,
      "text/html; charset=utf-8",
      `<!doctype html><title>WTS ${instanceId}</title><main><h1>Greeting workspace</h1></main>`,
    );
    return;
  }
  send(response, 404, "application/json", JSON.stringify({ error: "not_found" }));
});

server.listen(port, host, () => {
  console.log(`frontend ready on ${host}:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 1_000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
