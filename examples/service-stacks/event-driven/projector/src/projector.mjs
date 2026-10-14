import http from "node:http";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectOrder } from "./projection.mjs";

const host = "127.0.0.1";
const port = Number(process.env.PROJECTOR_PORT);
const instanceId = process.env.WTS_INSTANCE_ID ?? "unknown";
const stateDirectory = path.resolve(process.env.WTS_STATE_DIR ?? "");
const eventsDirectory = path.join(stateDirectory, "events");
const projectionsDirectory = path.join(stateDirectory, "projections");
const projected = new Set();
let polling = false;

if (!Number.isInteger(port) || port < 1 || port > 65535 || !process.env.WTS_STATE_DIR) {
  throw new Error("PROJECTOR_PORT and WTS_STATE_DIR must be injected");
}
await Promise.all(
  [eventsDirectory, projectionsDirectory].map((directory) => mkdir(directory, { recursive: true })),
);

async function writeJsonAtomic(target, value) {
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx" });
  await rename(temporary, target);
}

async function poll() {
  if (polling) {
    return;
  }
  polling = true;
  try {
    const names = (await readdir(eventsDirectory))
      .filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.json$/.test(name))
      .sort()
      .slice(0, 128);
    for (const name of names) {
      if (projected.has(name)) {
        continue;
      }
      const event = JSON.parse(await readFile(path.join(eventsDirectory, name), "utf8"));
      const target = path.join(projectionsDirectory, name);
      try {
        await writeJsonAtomic(target, projectOrder(event));
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
      }
      projected.add(name);
    }
  } finally {
    polling = false;
  }
}

const timer = setInterval(() => {
  poll().catch((error) => {
    console.error(`projection failed: ${error.message}`);
  });
}, 30);
timer.unref();
await poll();

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    const body = Buffer.from(
      JSON.stringify({
        status: "ok",
        service: "projector",
        instance: instanceId,
        projected: projected.size,
      }),
    );
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": body.length,
      "cache-control": "no-store",
    });
    response.end(body);
    return;
  }
  response.writeHead(404).end();
});

server.listen(port, host, () => {
  console.log(`projector ready on ${host}:${port}`);
});

function shutdown() {
  clearInterval(timer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 1_000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
