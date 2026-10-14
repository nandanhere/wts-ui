import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { installVerifiedApplication } from "./install-macos-app.mjs";

const identifier = "dev.wts.desktop";

async function writeApplicationBundle(root, bundleIdentifier, marker) {
  const application = join(root, "WTS.app");
  const executableDirectory = join(application, "Contents/MacOS");
  await mkdir(executableDirectory, { recursive: true });
  await writeFile(
    join(application, "Contents/Info.plist"),
    `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${bundleIdentifier}</string></dict></plist>`,
  );
  const executable = join(executableDirectory, "wts-desktop");
  await writeFile(executable, marker);
  await chmod(executable, 0o755);
  return application;
}

test("installs and replaces only the verified WTS application", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "wts-app-install-"));
  try {
    const sourceRoot = join(fixture, "source");
    const applicationsDirectory = join(fixture, "Applications");
    const source = await writeApplicationBundle(sourceRoot, identifier, "new");
    await writeApplicationBundle(applicationsDirectory, identifier, "old");

    const destination = await installVerifiedApplication({
      source,
      applicationsDirectory,
      expectedIdentifier: identifier,
    });

    assert.equal(destination, join(applicationsDirectory, "WTS.app"));
    assert.equal(
      await readFile(join(destination, "Contents/MacOS/wts-desktop"), "utf8"),
      "new",
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("does not replace an application with another bundle identifier", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "wts-app-install-"));
  try {
    const sourceRoot = join(fixture, "source");
    const applicationsDirectory = join(fixture, "Applications");
    const source = await writeApplicationBundle(sourceRoot, identifier, "new");
    await writeApplicationBundle(
      applicationsDirectory,
      "com.example.unrelated",
      "keep",
    );

    await assert.rejects(
      installVerifiedApplication({
        source,
        applicationsDirectory,
        expectedIdentifier: identifier,
      }),
      /application identifier does not match/,
    );
    assert.equal(
      await readFile(
        join(applicationsDirectory, "WTS.app/Contents/MacOS/wts-desktop"),
        "utf8",
      ),
      "keep",
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
