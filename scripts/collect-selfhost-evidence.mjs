#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

const MAX_FILES = 32;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_WALK_ENTRIES = 8_192;
const ALLOWED_FILES = new Set([
  "agent-report.json",
  "context.json",
  "graph-manifest.json",
  "verification-plan.json",
  "verification-result.json",
]);
const SENSITIVE_KEY =
  /(access.?key|api.?key|authorization|cookie|credential|password|private.?key|secret|token)/i;
const ABSOLUTE_PATH = /\/(?:[^/\s"']+\/)+[^/\s"',)}\]]+/g;

function usage() {
  console.error(
    "Usage: node scripts/collect-selfhost-evidence.mjs <runtime-root> <output-directory>",
  );
}

function sanitizeUrl(value) {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) {
      return null;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function sanitizeString(value, runtimeRoots) {
  let sanitized = value;
  for (const runtimeRoot of runtimeRoots) {
    sanitized = sanitized.split(runtimeRoot).join("[selfhost-runtime]");
  }
  const sanitizedUrl = sanitizeUrl(sanitized);
  if (sanitizedUrl !== null) {
    return sanitizedUrl;
  }
  return sanitized.replace(ABSOLUTE_PATH, (candidate) => {
    if (candidate.startsWith("/api/")) {
      return candidate;
    }
    return `[absolute-path]/${basename(candidate)}`;
  });
}

function sanitize(value, runtimeRoots, key = "") {
  if (SENSITIVE_KEY.test(key)) {
    return value === null ? null : "[redacted]";
  }
  if (typeof value === "string") {
    return sanitizeString(value, runtimeRoots);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, runtimeRoots));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitize(childValue, runtimeRoots, childKey),
      ]),
    );
  }
  return value;
}

async function collectEvidenceFiles(runtimeRoot) {
  const matches = [];
  const pending = [join(runtimeRoot, "workspaces")];
  let visited = 0;

  while (pending.length > 0 && matches.length < MAX_FILES) {
    const directory = pending.shift();
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_WALK_ENTRIES) {
        return matches;
      }
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") {
          continue;
        }
        pending.push(path);
        continue;
      }
      if (
        entry.isFile() &&
        basename(directory) === ".wts" &&
        ALLOWED_FILES.has(entry.name)
      ) {
        matches.push(path);
        if (matches.length >= MAX_FILES) {
          return matches;
        }
      }
    }
  }
  return matches.sort();
}

async function main() {
  const [runtimeArgument, outputArgument] = process.argv.slice(2);
  if (!runtimeArgument || !outputArgument) {
    usage();
    process.exitCode = 2;
    return;
  }

  const requestedRuntimeRoot = resolve(runtimeArgument);
  const runtimeRoot = await realpath(runtimeArgument);
  const outputRoot = resolve(outputArgument);
  if (
    outputRoot === runtimeRoot ||
    outputRoot.startsWith(`${runtimeRoot}${sep}`)
  ) {
    throw new Error("evidence output must be outside the disposable runtime");
  }

  await mkdir(outputRoot, { recursive: true });
  const sourceFiles = await collectEvidenceFiles(runtimeRoot);
  const manifest = {
    schemaVersion: 1,
    source: "isolated-wts-selfhost-runtime",
    bounded: true,
    redacted: true,
    limits: {
      maxFiles: MAX_FILES,
      maxSourceBytesPerFile: MAX_SOURCE_BYTES,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    },
    files: [],
    skipped: [],
  };
  let outputBytes = 0;

  for (const [index, sourcePath] of sourceFiles.entries()) {
    const source = await readFile(sourcePath);
    const sourceRelativePath = relative(runtimeRoot, sourcePath);
    if (source.byteLength > MAX_SOURCE_BYTES) {
      manifest.skipped.push({
        file: basename(sourcePath),
        reason: "source-too-large",
      });
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(source.toString("utf8"));
    } catch {
      manifest.skipped.push({
        file: basename(sourcePath),
        reason: "invalid-json",
      });
      continue;
    }
    const serialized = `${JSON.stringify(
      sanitize(parsed, [runtimeRoot, requestedRuntimeRoot]),
      null,
      2,
    )}\n`;
    const bytes = Buffer.byteLength(serialized);
    if (outputBytes + bytes > MAX_OUTPUT_BYTES) {
      manifest.skipped.push({
        file: basename(sourcePath),
        reason: "bundle-limit",
      });
      break;
    }

    const destinationName = `${String(index + 1).padStart(2, "0")}-${basename(
      sourcePath,
    )}`;
    await writeFile(join(outputRoot, destinationName), serialized, {
      flag: "wx",
      mode: 0o600,
    });
    outputBytes += bytes;
    manifest.files.push({
      file: destinationName,
      sourceKind: basename(sourcePath),
      sourceScopeHash: createHash("sha256")
        .update(sourceRelativePath)
        .digest("hex"),
      bytes,
      sha256: createHash("sha256").update(serialized).digest("hex"),
    });
  }

  await writeFile(
    join(outputRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    `Captured ${manifest.files.length} sanitized evidence file(s); ` +
      `${manifest.skipped.length} skipped.`,
  );
}

await main();
