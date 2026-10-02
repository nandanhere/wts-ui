#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStackManifest } from "./lib/stack-runtime.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STACKS = ["frontend-backend", "api-worker", "event-driven"];

function inside(root, relativePath, label) {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} escapes its fixture root`);
  }
  return resolved;
}

function runNpmTest(workingDirectory) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["test", "--silent"], {
      cwd: workingDirectory,
      env: { ...process.env, CI: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-64 * 1024);
    });
    child.stderr.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-64 * 1024);
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}

async function main() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "wts-collaboration-red-"));
  const workstreams = [];
  try {
    for (const stack of STACKS) {
      const stackRoot = path.join(ROOT, stack);
      await loadStackManifest(path.join(stackRoot, "wts-stack.json"));
      const collaboration = JSON.parse(
        await readFile(path.join(stackRoot, "agent-collaboration.json"), "utf8"),
      );
      if (
        collaboration.schemaVersion !== 1 ||
        collaboration.execution !== "parallel-then-integrate" ||
        !Array.isArray(collaboration.workstreams) ||
        !Array.isArray(collaboration.acceptanceInjections)
      ) {
        throw new Error(`${stack} collaboration manifest is invalid`);
      }

      const copyRoot = path.join(fixtureRoot, stack);
      const repositories = new Set(
        collaboration.workstreams.map((workstream) => workstream.repository),
      );
      await Promise.all(
        [...repositories].map((repository) =>
          cp(
            inside(stackRoot, repository, `${stack} repository`),
            path.join(copyRoot, repository),
            { recursive: true },
          ),
        ),
      );
      for (const injection of collaboration.acceptanceInjections) {
        if (!repositories.has(injection.repository)) {
          throw new Error(`${stack} acceptance injection uses an unknown repository`);
        }
        const source = inside(stackRoot, injection.source, `${stack} acceptance source`);
        const repositoryRoot = path.join(copyRoot, injection.repository);
        const target = inside(
          repositoryRoot,
          injection.target,
          `${stack} acceptance target`,
        );
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target);
      }
      for (const workstream of collaboration.workstreams) {
        workstreams.push({
          id: `${stack}/${workstream.id}`,
          workingDirectory: path.join(copyRoot, workstream.repository),
        });
      }
    }

    const results = await Promise.all(
      workstreams.map(async (workstream) => ({
        ...workstream,
        result: await runNpmTest(workstream.workingDirectory),
      })),
    );
    const unexpectedlyGreen = results.filter(({ result }) => result.code === 0);
    if (unexpectedlyGreen.length > 0) {
      throw new Error(
        `collaboration workstreams were not red: ${unexpectedlyGreen
          .map(({ id }) => id)
          .join(", ")}`,
      );
    }
    console.log(
      `Validated 3 stack manifests and ${results.length} deliberately red collaboration workstreams.`,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Fixture validation failed: ${error.message}`);
  process.exitCode = 1;
});
