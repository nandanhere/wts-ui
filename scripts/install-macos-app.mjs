import { randomUUID } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const defaultSource = join(
  projectRoot,
  "target/release/bundle/macos/WTS.app",
);
const defaultApplicationsDirectory = "/Applications";

function fail(message) {
  throw new Error(`WTS macOS install: ${message}`);
}

function plistBundleIdentifier(plist) {
  const match = plist.match(
    /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/,
  );
  return match?.[1]?.trim() ?? null;
}

async function validateApplicationBundle(application, expectedIdentifier) {
  const stat = await lstat(application).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    fail(`the application bundle is invalid: ${application}`);
  }

  const plistPath = join(application, "Contents/Info.plist");
  const plist = await readFile(plistPath, "utf8").catch(() => null);
  if (!plist || plistBundleIdentifier(plist) !== expectedIdentifier) {
    fail(`the application identifier does not match ${expectedIdentifier}.`);
  }

  await access(
    join(application, "Contents/MacOS/wts-desktop"),
    constants.X_OK,
  ).catch(() => fail("the WTS executable is missing or is not executable."));
}

export async function installVerifiedApplication({
  source,
  applicationsDirectory,
  expectedIdentifier,
}) {
  if (!isAbsolute(source) || !isAbsolute(applicationsDirectory)) {
    fail("the source and Applications paths must be absolute.");
  }
  if (basename(source) !== "WTS.app") {
    fail("the source bundle must be named WTS.app.");
  }

  await validateApplicationBundle(source, expectedIdentifier);
  await mkdir(applicationsDirectory, { recursive: true });

  const destination = join(applicationsDirectory, "WTS.app");
  const existing = await lstat(destination).catch(() => null);
  if (existing) {
    await validateApplicationBundle(destination, expectedIdentifier);
  }

  const suffix = `${process.pid}-${randomUUID()}`;
  const staging = join(applicationsDirectory, `.WTS.app.install-${suffix}`);
  const backup = join(applicationsDirectory, `.WTS.app.backup-${suffix}`);

  try {
    await cp(source, staging, { recursive: true, preserveTimestamps: true });
    await validateApplicationBundle(staging, expectedIdentifier);

    if (existing) {
      await rename(destination, backup);
    }
    try {
      await rename(staging, destination);
    } catch (error) {
      if (existing) {
        await rename(backup, destination).catch(() => {});
      }
      throw error;
    }
    if (existing) {
      await rm(backup, { recursive: true, force: true });
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }

  return destination;
}

async function main() {
  if (process.platform !== "darwin") {
    fail("this command supports macOS only.");
  }

  const config = JSON.parse(
    await readFile(join(projectRoot, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const source = resolve(process.env.WTS_MACOS_APP_SOURCE ?? defaultSource);
  const applicationsDirectory = resolve(
    process.env.WTS_APPLICATIONS_DIR ?? defaultApplicationsDirectory,
  );
  const destination = await installVerifiedApplication({
    source,
    applicationsDirectory,
    expectedIdentifier: config.identifier,
  });
  process.stdout.write(`WTS is installed at ${destination}.\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
