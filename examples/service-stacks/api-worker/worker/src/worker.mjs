import http from "node:http";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { processJob } from "./processor.mjs";

const host = "127.0.0.1";
const port = Number(process.env.JOBS_WORKER_PORT);
const instanceId = process.env.WTS_INSTANCE_ID ?? "unknown";
const stateDirectory = path.resolve(process.env.WTS_STATE_DIR ?? "");
const queueDirectory = path.join(stateDirectory, "queue");
const processingDirectory = path.join(stateDirectory, "processing");
const resultsDirectory = path.join(stateDirectory, "results");
let processed = 0;
let polling = false;

if (!Number.isInteger(port) || port < 1 || port > 65535 || !process.env.WTS_STATE_DIR) {
  throw new Error("JOBS_WORKER_PORT and WTS_STATE_DIR must be injected");
}

await Promise.all(
  [queueDirectory, processingDirectory, resultsDirectory].map((directory) =>
    mkdir(directory, { recursive: true }),
  ),
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
    const names = (await readdir(queueDirectory))
      .filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.json$/.test(name))
      .sort()
      .slice(0, 8);
    for (const name of names) {
      const queued = path.join(queueDirectory, name);
      const claimed = path.join(processingDirectory, name);
      try {
        await rename(queued, claimed);
      } catch (error) {
        if (error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      const job = JSON.parse(await readFile(claimed, "utf8"));
      await writeJsonAtomic(path.join(resultsDirectory, name), {
        ...processJob(job),
        instance: instanceId,
      });
      await unlink(claimed);
      processed += 1;
    }
  } finally {
    polling = false;
  }
}

const timer = setInterval(() => {
  poll().catch((error) => {
    console.error(`worker poll failed: ${error.message}`);
  });
}, 30);
timer.unref();
await poll();

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    const body = Buffer.from(
      JSON.stringify({
        status: "ok",
        service: "jobs-worker",
        instance: instanceId,
        processed,
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
  console.log(`jobs worker ready on ${host}:${port}`);
});

function shutdown() {
  clearInterval(timer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 1_000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
