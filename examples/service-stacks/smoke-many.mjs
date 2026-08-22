#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStackSmoke, startStack, stopStack } from "./lib/stack-runtime.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STACKS = ["frontend-backend", "api-worker", "event-driven"];
const SLOT_SIZE = 10;

function usage() {
  console.log(`Usage:
  node smoke-many.mjs [options]

Options:
  --copies COUNT       Copies per selected stack (default: 2, max: 10)
  --stack NAME         all, frontend-backend, api-worker, or event-driven
  --base-port PORT     First ten-port slot (default: 48000)
  --hold-ms MS         Keep healthy stacks alive before smoke (default: 0, max: 60000)
  --output PATH        Optional JSON report path
  -h, --help           Show this help`);
}

function parseArguments(arguments_) {
  const options = { copies: 2, stack: "all", basePort: 48_000, holdMs: 0 };
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
      case "--copies":
        options.copies = Number(next());
        break;
      case "--stack":
        options.stack = next();
        break;
      case "--base-port":
        options.basePort = Number(next());
        break;
      case "--hold-ms":
        options.holdMs = Number(next());
        break;
      case "--output":
        options.output = path.resolve(next());
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
  if (!Number.isInteger(options.copies) || options.copies < 1 || options.copies > 10) {
    throw new Error("--copies must be between 1 and 10");
  }
  if (options.stack !== "all" && !STACKS.includes(options.stack)) {
    throw new Error(`--stack must be all or one of: ${STACKS.join(", ")}`);
  }
  if (!Number.isInteger(options.holdMs) || options.holdMs < 0 || options.holdMs > 60_000) {
    throw new Error("--hold-ms must be between 0 and 60000");
  }
  const stackCount = options.stack === "all" ? STACKS.length : 1;
  const finalPort = options.basePort + stackCount * options.copies * SLOT_SIZE - 1;
  if (!Number.isInteger(options.basePort) || options.basePort < 1024 || finalPort > 65535) {
    throw new Error("the requested base-port range is invalid");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const selectedStacks = options.stack === "all" ? STACKS : [options.stack];
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "wts-stacks-many-"));
  const configurations = [];
  let slot = 0;
  for (const stack of selectedStacks) {
    for (let copy = 1; copy <= options.copies; copy += 1) {
      const instanceId = `${stack}-${copy}`;
      configurations.push({
        stack,
        instanceId,
        manifestFile: path.join(ROOT, stack, "wts-stack.json"),
        basePort: options.basePort + slot * SLOT_SIZE,
        stateDirectory: path.join(stateRoot, instanceId),
      });
      slot += 1;
    }
  }

  const startedAt = Date.now();
  let runtimes = [];
  try {
    const starts = await Promise.allSettled(configurations.map((config) => startStack(config)));
    runtimes = starts.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const failed = starts.find((result) => result.status === "rejected");
    if (failed) {
      throw failed.reason;
    }

    if (options.holdMs > 0) {
      console.error(
        `Holding ${runtimes.length} healthy stack copies (${runtimes.reduce(
          (total, runtime) => total + runtime.processes.length,
          0,
        )} processes) for ${options.holdMs}ms.`,
      );
      await new Promise((resolve) => setTimeout(resolve, options.holdMs));
    }

    const smokeResults = await Promise.all(
      runtimes.map(async (runtime) => ({
        stack: runtime.id,
        instance: runtime.instanceId,
        ports: runtime.ports,
        processCount: runtime.processes.length,
        ...(await runStackSmoke(runtime)),
      })),
    );
    const report = {
      schemaVersion: 1,
      passed: true,
      stackCopies: runtimes.length,
      processCount: runtimes.reduce((total, runtime) => total + runtime.processes.length, 0),
      holdMs: options.holdMs,
      wallMs: Date.now() - startedAt,
      results: smokeResults,
    };
    console.log(JSON.stringify(report, null, 2));
    if (options.output) {
      await mkdir(path.dirname(options.output), { recursive: true });
      await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
    }
  } finally {
    await Promise.all(runtimes.map((runtime) => stopStack(runtime)));
    await rm(stateRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Simultaneous stack smoke failed: ${error.message}`);
  process.exitCode = 1;
});
