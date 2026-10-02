#!/usr/bin/env node

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runStackSmoke,
  startStack,
  stopStack,
} from "./lib/stack-runtime.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const basePort = Number(process.argv[2] ?? "49700");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function canBind(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

async function assertPortsReleased() {
  await Promise.all([canBind(basePort), canBind(basePort + 1)]);
}

async function main() {
  assert(Number.isInteger(basePort) && basePort >= 1024 && basePort <= 65534, "invalid port");
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "wts-runtime-cleanup-"));
  const sourceStack = path.join(ROOT, "frontend-backend");
  const brokenStack = path.join(temporaryRoot, "broken-stack");
  let runtime;
  try {
    await cp(sourceStack, brokenStack, { recursive: true });
    const brokenManifestPath = path.join(brokenStack, "wts-stack.json");
    const brokenManifest = JSON.parse(await readFile(brokenManifestPath, "utf8"));
    brokenManifest.processes[1].arguments = ["src/does-not-exist.mjs"];
    await writeFile(brokenManifestPath, `${JSON.stringify(brokenManifest, null, 2)}\n`);

    let rejected = false;
    try {
      await startStack({
        manifestFile: brokenManifestPath,
        instanceId: "expected-startup-failure",
        basePort,
        stateDirectory: path.join(temporaryRoot, "broken-state"),
        healthTimeoutMs: 2_000,
      });
    } catch {
      rejected = true;
    }
    assert(rejected, "broken stack unexpectedly became healthy");
    await assertPortsReleased();

    runtime = await startStack({
      manifestFile: path.join(sourceStack, "wts-stack.json"),
      instanceId: "cleanup-success",
      basePort,
      stateDirectory: path.join(temporaryRoot, "success-state"),
    });
    await runStackSmoke(runtime);
    await stopStack(runtime);
    runtime = undefined;
    await assertPortsReleased();
    console.log("Startup failure and successful shutdown both released every fixture port.");
  } finally {
    if (runtime) {
      await stopStack(runtime);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Runtime cleanup validation failed: ${error.message}`);
  process.exitCode = 1;
});
