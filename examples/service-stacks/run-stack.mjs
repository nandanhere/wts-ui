#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startStack, stopStack, runStackSmoke } from "./lib/stack-runtime.mjs";

function usage() {
  console.log(`Usage:
  node run-stack.mjs --manifest PATH --base-port PORT [options]

Options:
  --instance ID          Instance identifier (default: local-1)
  --state-dir PATH       Isolated state directory (default: temporary)
  --smoke                Run the manifest smoke probe after health is ready
  --exit-after-smoke     Stop after the smoke probe passes
  --health-timeout MS    Startup health timeout (default: 8000)
  -h, --help             Show this help`);
}

function parseArguments(arguments_) {
  const options = {
    instanceId: "local-1",
    smoke: false,
    exitAfterSmoke: false,
    healthTimeoutMs: 8_000,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const next = () => {
      index += 1;
      if (index >= arguments_.length) {
        throw new Error(`${argument} requires a value`);
      }
      return arguments_[index];
    };
    switch (argument) {
      case "--manifest":
        options.manifestFile = next();
        break;
      case "--base-port":
        options.basePort = Number(next());
        break;
      case "--instance":
        options.instanceId = next();
        break;
      case "--state-dir":
        options.stateDirectory = next();
        break;
      case "--health-timeout":
        options.healthTimeoutMs = Number(next());
        break;
      case "--smoke":
        options.smoke = true;
        break;
      case "--exit-after-smoke":
        options.exitAfterSmoke = true;
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!options.manifestFile) {
    throw new Error("--manifest is required");
  }
  if (!Number.isInteger(options.basePort)) {
    throw new Error("--base-port is required and must be an integer");
  }
  if (!Number.isInteger(options.healthTimeoutMs) || options.healthTimeoutMs < 100) {
    throw new Error("--health-timeout must be an integer of at least 100ms");
  }
  if (options.exitAfterSmoke && !options.smoke) {
    throw new Error("--exit-after-smoke requires --smoke");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  let ownsStateDirectory = false;
  if (!options.stateDirectory) {
    options.stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wts-stack-"));
    ownsStateDirectory = true;
  }

  let runtime;
  try {
    runtime = await startStack(options);
    console.log(
      `WTS_STACK_READY ${JSON.stringify({
        stack: runtime.id,
        instance: runtime.instanceId,
        ports: runtime.ports,
        stateDirectory: runtime.stateDirectory,
        processCount: runtime.processes.length,
      })}`,
    );

    if (options.smoke) {
      const smoke = await runStackSmoke(runtime);
      console.log(
        `WTS_STACK_SMOKE_PASSED ${JSON.stringify({
          stack: runtime.id,
          instance: runtime.instanceId,
          durationMs: smoke.durationMs,
          detail: smoke.stdout,
        })}`,
      );
    }
    if (!options.exitAfterSmoke) {
      await new Promise((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
    }
  } finally {
    if (runtime) {
      await stopStack(runtime);
    }
    if (ownsStateDirectory && options.exitAfterSmoke) {
      await rm(options.stateDirectory, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(`WTS stack failed: ${error.message}`);
  process.exitCode = 1;
});
