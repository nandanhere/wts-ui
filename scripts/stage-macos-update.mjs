import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const maxArtifactBytes = 512 * 1024 * 1024;
const stagedArtifactPattern = /^WTS_(\d+\.\d+\.\d+)_aarch64\.app\.tar\.gz$/;
const versionPattern = /^(0|[1-9]\d{0,9})\.(0|[1-9]\d{0,9})\.(0|[1-9]\d{0,9})$/;

function fail(message) {
  throw new Error(`WTS macOS update: ${message}`);
}

async function regularFile(path, label, maximumSize = maxArtifactBytes) {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} must be a regular file.`);
  }
  if (metadata.size < 1 || metadata.size > maximumSize) {
    fail(`${label} has an invalid size.`);
  }
  return metadata;
}

async function sha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

function validSignature(value) {
  if (
    value.length < 1 ||
    value.length > 4096 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return false;
  }
  try {
    return Buffer.from(value, "base64").length > 0;
  } catch {
    return false;
  }
}

async function safeDirectory(path) {
  if (!isAbsolute(path)) {
    fail("the update directory must be an absolute path.");
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("the update directory must be a regular directory.");
  }
  await chmod(path, 0o700);
}

export async function nextBuildVersion(sequenceFile, epochSeconds) {
  if (!isAbsolute(sequenceFile)) {
    fail("the build sequence path must be absolute.");
  }
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 1) {
    fail("the current build time must be a positive integer.");
  }
  await safeDirectory(dirname(sequenceFile));
  const existing = await lstat(sequenceFile).catch(() => null);
  let previous = 0;
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size > 32) {
      fail("the build sequence file is invalid.");
    }
    const value = (await readFile(sequenceFile, "utf8")).trim();
    if (!/^[1-9]\d{0,9}$/.test(value)) {
      fail("the build sequence file is invalid.");
    }
    previous = Number(value);
    if (!Number.isSafeInteger(previous)) {
      fail("the build sequence file is invalid.");
    }
  }
  const next = Math.max(epochSeconds, previous + 1);
  if (next > 9_999_999_999) {
    fail("the next build sequence is too large.");
  }
  const staging = `${sequenceFile}.stage-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(staging, `${next}\n`, { mode: 0o600, flag: "wx" });
    await rename(staging, sequenceFile);
    await chmod(sequenceFile, 0o600);
  } finally {
    await rm(staging, { force: true }).catch(() => {});
  }
  return `0.1.${next}`;
}

export async function stageMacosUpdate({
  artifact,
  signatureFile,
  updateDirectory,
  version,
  publishedAt,
  notes = "Local QA build.",
}) {
  if (!isAbsolute(artifact) || !isAbsolute(signatureFile)) {
    fail("the artifact and signature paths must be absolute.");
  }
  if (!versionPattern.test(version)) {
    fail("the update version must be a bounded semantic version.");
  }
  if (
    typeof publishedAt !== "string" ||
    publishedAt.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(publishedAt)
  ) {
    fail("the update publication time is invalid.");
  }
  if (typeof notes !== "string" || notes.length > 4000 || notes.includes("\0")) {
    fail("the update notes are invalid.");
  }
  await safeDirectory(updateDirectory);
  const artifactMetadata = await regularFile(artifact, "the updater artifact");
  await regularFile(signatureFile, "the updater signature", 4096);
  const signature = (await readFile(signatureFile, "utf8")).trim();
  if (!validSignature(signature)) {
    fail("the updater signature is invalid.");
  }

  const artifactFile = `WTS_${version}_aarch64.app.tar.gz`;
  const stagedPath = join(updateDirectory, artifactFile);
  const suffix = `${process.pid}-${randomUUID()}`;
  const artifactStaging = join(updateDirectory, `.${artifactFile}.stage-${suffix}`);
  const manifestStaging = join(updateDirectory, `.latest.json.stage-${suffix}`);
  const manifestPath = join(updateDirectory, "latest.json");
  const previousManifestMetadata = await lstat(manifestPath).catch(() => null);
  if (previousManifestMetadata) {
    if (
      !previousManifestMetadata.isFile() ||
      previousManifestMetadata.isSymbolicLink() ||
      previousManifestMetadata.size > 64 * 1024
    ) {
      fail("the existing update manifest is invalid.");
    }
    try {
      const previousManifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (
        typeof previousManifest.version !== "string" ||
        !versionPattern.test(previousManifest.version)
      ) {
        fail("the existing update manifest is invalid.");
      }
      const previousParts = previousManifest.version.split(".").map(Number);
      const nextParts = version.split(".").map(Number);
      const advances = nextParts.some(
        (part, index) =>
          part > previousParts[index] &&
          nextParts.slice(0, index).every((value, prior) => value === previousParts[prior]),
      );
      if (!advances) {
        fail("the update version must advance the existing version.");
      }
    } catch {
      fail("the existing update manifest is invalid or newer.");
    }
  }

  try {
    await copyFile(artifact, artifactStaging);
    const stagedMetadata = await regularFile(
      artifactStaging,
      "the staged updater artifact",
    );
    if (stagedMetadata.size !== artifactMetadata.size) {
      fail("the staged updater artifact size changed.");
    }
    const digest = await sha256(artifactStaging);
    await chmod(artifactStaging, 0o600);
    await rename(artifactStaging, stagedPath);

    const manifest = {
      schemaVersion: 1,
      version,
      notes,
      pubDate: publishedAt,
      artifactFile,
      signature,
      sha256: digest,
      size: stagedMetadata.size,
    };
    await writeFile(manifestStaging, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(manifestStaging, manifestPath);
    await chmod(manifestPath, 0o600);

    for (const entry of await readdir(updateDirectory)) {
      if (entry !== artifactFile && stagedArtifactPattern.test(entry)) {
        const previousPath = join(updateDirectory, entry);
        const previousMetadata = await lstat(previousPath).catch(() => null);
        if (previousMetadata?.isFile() && !previousMetadata.isSymbolicLink()) {
          await rm(previousPath);
        }
      }
    }
    return { manifest, artifactPath: stagedPath, manifestPath };
  } finally {
    await rm(artifactStaging, { force: true }).catch(() => {});
    await rm(manifestStaging, { force: true }).catch(() => {});
  }
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === "next-version" && args.length === 2) {
    const epoch = Number(args[1]);
    process.stdout.write(`${await nextBuildVersion(resolve(args[0]), epoch)}\n`);
    return;
  }
  if (operation === "stage" && args.length === 5) {
    const result = await stageMacosUpdate({
      artifact: resolve(args[0]),
      signatureFile: resolve(args[1]),
      updateDirectory: resolve(args[2]),
      version: args[3],
      publishedAt: args[4],
    });
    process.stdout.write(`${result.artifactPath}\n${result.manifestPath}\n`);
    return;
  }
  fail("use next-version or stage with the required arguments.");
}

const currentFile = fileURLToPath(import.meta.url);
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(currentFile).href
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
