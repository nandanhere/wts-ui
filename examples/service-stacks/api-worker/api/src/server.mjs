import http from "node:http";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeJob } from "./job.mjs";

const host = "127.0.0.1";
const port = Number(process.env.JOBS_API_PORT);
const instanceId = process.env.WTS_INSTANCE_ID ?? "unknown";
const stateDirectory = path.resolve(process.env.WTS_STATE_DIR ?? "");
const queueDirectory = path.join(stateDirectory, "queue");
const processingDirectory = path.join(stateDirectory, "processing");
const resultsDirectory = path.join(stateDirectory, "results");
const MAX_PENDING_JOBS = 128;

if (!Number.isInteger(port) || port < 1 || port > 65535 || !process.env.WTS_STATE_DIR) {
  throw new Error("JOBS_API_PORT and WTS_STATE_DIR must be injected");
}

await Promise.all(
  [queueDirectory, processingDirectory, resultsDirectory].map((directory) =>
    mkdir(directory, { recursive: true }),
  ),
);

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
        reject(new Error("request body is too large"));
        request.destroy();
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

async function existingJob(id) {
  for (const [directory, status] of [
    [resultsDirectory, "complete"],
    [processingDirectory, "processing"],
    [queueDirectory, "queued"],
  ]) {
    try {
      const job = JSON.parse(await readFile(path.join(directory, `${id}.json`), "utf8"));
      return { status, job };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return null;
}

async function submitJob(raw) {
  const job = normalizeJob(raw);
  const existing = await existingJob(job.id);
  if (existing) {
    return { created: false, status: existing.status, job: existing.job };
  }
  if ((await readdir(queueDirectory)).length >= MAX_PENDING_JOBS) {
    const error = new Error("queue is full");
    error.code = "QUEUE_FULL";
    throw error;
  }
  const target = path.join(queueDirectory, `${job.id}.json`);
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(job)}\n`, { flag: "wx" });
  await rename(temporary, target);
  return { created: true, status: "queued", job };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      service: "jobs-api",
      instance: instanceId,
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/jobs") {
    try {
      const submitted = await submitJob(await readJsonBody(request));
      sendJson(response, submitted.created ? 202 : 200, submitted);
    } catch (error) {
      sendJson(response, error.code === "QUEUE_FULL" ? 503 : 400, {
        error: error.code === "QUEUE_FULL" ? "queue_full" : "invalid_job",
      });
    }
    return;
  }
  const match = request.method === "GET" && url.pathname.match(/^\/jobs\/([a-zA-Z0-9_-]+)$/);
  if (match) {
    const existing = await existingJob(match[1]);
    sendJson(response, existing ? 200 : 404, existing ?? { error: "not_found" });
    return;
  }
  sendJson(response, 404, { error: "not_found" });
});

server.listen(port, host, () => {
  console.log(`jobs API ready on ${host}:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 1_000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
