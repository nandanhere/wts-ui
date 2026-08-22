import { spawn } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const HOST = "127.0.0.1";
const MAX_CAPTURE_BYTES = 1024 * 1024;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeRelativeDirectory(root, candidate, label) {
  assert(typeof candidate === "string", `${label} must be a string`);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  assert(
    relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)),
    `${label} escapes the stack directory`,
  );
  return resolved;
}

function validateManifest(manifest, manifestPath) {
  assert(isRecord(manifest), "stack manifest must be a JSON object");
  assert(manifest.schemaVersion === 1, "unsupported stack manifest schemaVersion");
  assert(
    typeof manifest.id === "string" && /^[a-z][a-z0-9-]{1,63}$/.test(manifest.id),
    "stack id is invalid",
  );
  assert(Array.isArray(manifest.ports) && manifest.ports.length > 0, "ports are required");
  assert(
    Array.isArray(manifest.processes) && manifest.processes.length > 0,
    "processes are required",
  );

  const portIds = new Set();
  const portOffsets = new Set();
  const environmentNames = new Set();
  for (const port of manifest.ports) {
    assert(isRecord(port), "port entries must be objects");
    assert(
      typeof port.id === "string" && /^[a-z][a-z0-9-]*$/.test(port.id),
      "port id is invalid",
    );
    assert(!portIds.has(port.id), `duplicate port id: ${port.id}`);
    assert(
      typeof port.environment === "string" &&
        /^[A-Z][A-Z0-9_]*_PORT$/.test(port.environment),
      `port ${port.id} has an invalid environment name`,
    );
    assert(
      Number.isInteger(port.offset) && port.offset >= 0 && port.offset < 10,
      `port ${port.id} offset must be between 0 and 9`,
    );
    assert(!portOffsets.has(port.offset), `duplicate port offset: ${port.offset}`);
    assert(
      !environmentNames.has(port.environment),
      `duplicate port environment: ${port.environment}`,
    );
    portIds.add(port.id);
    portOffsets.add(port.offset);
    environmentNames.add(port.environment);
  }

  const root = path.dirname(manifestPath);
  const processIds = new Set();
  for (const processDefinition of manifest.processes) {
    assert(isRecord(processDefinition), "process entries must be objects");
    assert(
      typeof processDefinition.id === "string" &&
        /^[a-z][a-z0-9-]*$/.test(processDefinition.id),
      "process id is invalid",
    );
    assert(
      !processIds.has(processDefinition.id),
      `duplicate process id: ${processDefinition.id}`,
    );
    processIds.add(processDefinition.id);
    assert(
      processDefinition.executable === "node",
      `process ${processDefinition.id} must use the dependency-free node executable`,
    );
    assert(
      Array.isArray(processDefinition.arguments) &&
        processDefinition.arguments.every((argument) => typeof argument === "string"),
      `process ${processDefinition.id} arguments are invalid`,
    );
    assert(
      Array.isArray(processDefinition.dependencies) &&
        processDefinition.dependencies.every((dependency) => typeof dependency === "string"),
      `process ${processDefinition.id} dependencies are invalid`,
    );
    for (const dependency of processDefinition.dependencies) {
      assert(
        processIds.has(dependency),
        `process ${processDefinition.id} dependency ${dependency} must be declared earlier`,
      );
    }
    safeRelativeDirectory(
      root,
      processDefinition.workingDirectory,
      `process ${processDefinition.id} workingDirectory`,
    );
    assert(isRecord(processDefinition.health), `process ${processDefinition.id} needs health`);
    assert(
      portIds.has(processDefinition.health.port),
      `process ${processDefinition.id} health port is unknown`,
    );
    assert(
      typeof processDefinition.health.path === "string" &&
        processDefinition.health.path.startsWith("/"),
      `process ${processDefinition.id} health path is invalid`,
    );
  }

  assert(isRecord(manifest.smoke), "smoke definition is required");
  assert(manifest.smoke.executable === "node", "smoke executable must be node");
  assert(
    Array.isArray(manifest.smoke.arguments) &&
      manifest.smoke.arguments.every((argument) => typeof argument === "string"),
    "smoke arguments are invalid",
  );
  safeRelativeDirectory(root, manifest.smoke.workingDirectory, "smoke workingDirectory");
}

export async function loadStackManifest(manifestFile) {
  const manifestPath = path.resolve(manifestFile);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest, manifestPath);
  return { manifest, manifestPath, root: path.dirname(manifestPath) };
}

export function resolvePorts(manifest, basePort) {
  assert(Number.isInteger(basePort), "base port must be an integer");
  assert(basePort >= 1024 && basePort <= 65526, "base port must be between 1024 and 65526");
  const ports = {};
  const environment = {};
  for (const definition of manifest.ports) {
    const port = basePort + definition.offset;
    assert(port <= 65535, `port ${definition.id} exceeds 65535`);
    ports[definition.id] = port;
    environment[definition.environment] = String(port);
  }
  return { ports, environment };
}

function portAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        resolve(false);
      } else {
        reject(error);
      }
    });
    server.listen({ host: HOST, port, exclusive: true }, () => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(true);
        }
      });
    });
  });
}

async function preflightPorts(ports) {
  for (const [name, port] of Object.entries(ports)) {
    assert(await portAvailable(port), `port ${name} (${port}) is already in use`);
  }
}

function boundedAppend(current, chunk) {
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= MAX_CAPTURE_BYTES
    ? combined
    : combined.subarray(combined.length - MAX_CAPTURE_BYTES);
}

function attachOutput(child, instanceId, processId) {
  const prefix = `[${instanceId}/${processId}] `;
  let tail = Buffer.alloc(0);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      tail = boundedAppend(tail, chunk);
      const lines = chunk.toString("utf8").split("\n");
      for (const line of lines) {
        if (line.length > 0) {
          process.stderr.write(`${prefix}${line}\n`);
        }
      }
    });
  }
  return () => tail.toString("utf8");
}

export function requestJson({ port, method = "GET", requestPath = "/", body, timeoutMs = 500 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = http.request(
      {
        host: HOST,
        port,
        path: requestPath,
        method,
        timeout: timeoutMs,
        headers:
          payload === undefined
            ? undefined
            : {
                "content-type": "application/json",
                "content-length": payload.length,
              },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size <= MAX_CAPTURE_BYTES) {
            chunks.push(chunk);
          } else {
            request.destroy(new Error("HTTP response exceeded the fixture limit"));
          }
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = text.length === 0 ? null : JSON.parse(text);
          } catch {
            reject(new Error(`port ${port} returned invalid JSON`));
            return;
          }
          resolve({ status: response.statusCode ?? 0, json });
        });
      },
    );
    request.once("timeout", () => request.destroy(new Error(`port ${port} timed out`)));
    request.once("error", reject);
    if (payload !== undefined) {
      request.write(payload);
    }
    request.end();
  });
}

async function waitForHealth(runtimeProcess, port, healthPath, timeoutMs) {
  const started = Date.now();
  let lastError = "health endpoint did not respond";
  while (Date.now() - started < timeoutMs) {
    if (runtimeProcess.spawnError) {
      throw new Error(`${runtimeProcess.id} could not start: ${runtimeProcess.spawnError.message}`);
    }
    if (runtimeProcess.child.exitCode !== null) {
      throw new Error(
        `${runtimeProcess.id} exited before becoming healthy: ${runtimeProcess.outputTail()}`,
      );
    }
    try {
      const response = await requestJson({
        port,
        requestPath: healthPath,
        timeoutMs: Math.min(500, timeoutMs),
      });
      if (response.status === 200 && response.json?.status === "ok") {
        return;
      }
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`${runtimeProcess.id} was not healthy: ${lastError}`);
}

function processEnvironment(portEnvironment, instanceId, stateDirectory, extra) {
  return {
    ...process.env,
    ...extra,
    ...portEnvironment,
    WTS_INSTANCE_ID: instanceId,
    WTS_STATE_DIR: stateDirectory,
    NODE_ENV: "test",
  };
}

export async function startStack({
  manifestFile,
  instanceId,
  basePort,
  stateDirectory,
  healthTimeoutMs = 8_000,
}) {
  assert(
    typeof instanceId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(instanceId),
    "instance id is invalid",
  );
  const loaded = await loadStackManifest(manifestFile);
  const { ports, environment: portEnvironment } = resolvePorts(loaded.manifest, basePort);
  const resolvedStateDirectory = path.resolve(stateDirectory);
  await mkdir(resolvedStateDirectory, { recursive: true });
  await preflightPorts(ports);

  const runtimeProcesses = [];
  try {
    for (const definition of loaded.manifest.processes) {
      const workingDirectory = safeRelativeDirectory(
        loaded.root,
        definition.workingDirectory,
        `${definition.id} workingDirectory`,
      );
      const child = spawn(definition.executable, definition.arguments, {
        cwd: workingDirectory,
        env: processEnvironment(
          portEnvironment,
          instanceId,
          resolvedStateDirectory,
          definition.environment ?? {},
        ),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const runtimeProcess = {
        id: definition.id,
        child,
        spawnError: null,
        outputTail: attachOutput(child, instanceId, definition.id),
      };
      runtimeProcesses.push(runtimeProcess);
      child.once("error", (error) => {
        runtimeProcess.spawnError = error;
      });
    }

    await Promise.all(
      loaded.manifest.processes.map((definition, index) =>
        waitForHealth(
          runtimeProcesses[index],
          ports[definition.health.port],
          definition.health.path,
          healthTimeoutMs,
        ),
      ),
    );
  } catch (error) {
    await stopStack({ processes: runtimeProcesses });
    throw error;
  }

  return {
    id: loaded.manifest.id,
    manifest: loaded.manifest,
    manifestPath: loaded.manifestPath,
    root: loaded.root,
    instanceId,
    stateDirectory: resolvedStateDirectory,
    ports,
    portEnvironment,
    processes: runtimeProcesses,
    startedAtUnixMs: Date.now(),
  };
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export async function stopStack(runtime) {
  const processes = runtime.processes ?? [];
  for (const entry of [...processes].reverse()) {
    if (entry.child.exitCode === null && entry.child.signalCode === null) {
      entry.child.kill("SIGTERM");
    }
  }
  const exited = await Promise.all(processes.map((entry) => waitForExit(entry.child, 1_500)));
  await Promise.all(
    processes.map(async (entry, index) => {
      if (!exited[index] && entry.child.exitCode === null && entry.child.signalCode === null) {
        entry.child.kill("SIGKILL");
        await waitForExit(entry.child, 500);
      }
    }),
  );
}

function runCaptured(executable, arguments_, options) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(executable, arguments_, {
      ...options,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let capturedBytes = 0;
    let exceeded = false;
    child.stdout.on("data", (chunk) => {
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        exceeded = true;
        child.kill("SIGKILL");
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk) => {
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        exceeded = true;
        child.kill("SIGKILL");
        return;
      }
      stderr = Buffer.concat([stderr, chunk]);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("smoke probe timed out"));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (exceeded) {
        reject(new Error("smoke probe output exceeded the fixture limit"));
      } else if (code !== 0) {
        reject(
          new Error(
            `smoke probe failed (${code ?? signal}): ${stderr.toString("utf8").trim()}`,
          ),
        );
      } else {
        resolve({
          durationMs: Date.now() - started,
          stdout: stdout.toString("utf8").trim(),
        });
      }
    });
  });
}

export async function runStackSmoke(runtime) {
  const definition = runtime.manifest.smoke;
  const workingDirectory = safeRelativeDirectory(
    runtime.root,
    definition.workingDirectory,
    "smoke workingDirectory",
  );
  return runCaptured(definition.executable, definition.arguments, {
    cwd: workingDirectory,
    env: processEnvironment(
      runtime.portEnvironment,
      runtime.instanceId,
      runtime.stateDirectory,
      definition.environment ?? {},
    ),
  });
}
