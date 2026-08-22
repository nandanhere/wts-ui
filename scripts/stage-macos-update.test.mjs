import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  nextBuildVersion,
  stageMacosUpdate,
} from "./stage-macos-update.mjs";

const signature = Buffer.from("minisign signature fixture").toString("base64");

async function inputs(root, contents, suffix = "") {
  const artifact = join(root, `WTS.app${suffix}.tar.gz`);
  const signatureFile = `${artifact}.sig`;
  await writeFile(artifact, contents);
  await writeFile(signatureFile, `${signature}\n`);
  return { artifact, signatureFile };
}

test("creates monotonic build versions and rejects a symlinked sequence", async () => {
  const root = await mkdtemp(join(tmpdir(), "wts-update-version-"));
  try {
    const sequence = join(root, "build-sequence");
    assert.equal(await nextBuildVersion(sequence, 100), "0.1.100");
    assert.equal(await nextBuildVersion(sequence, 99), "0.1.101");
    await rm(sequence);
    const target = join(root, "outside-sequence");
    await writeFile(target, "200\n");
    await symlink(target, sequence);
    await assert.rejects(nextBuildVersion(sequence, 201), /sequence file is invalid/);
    assert.equal(await readFile(target, "utf8"), "200\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomically stages only the newest signed artifact and complete manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "wts-update-stage-"));
  try {
    const updateDirectory = join(root, "updates");
    const first = await inputs(root, "first signed artifact", "-first");
    await stageMacosUpdate({
      ...first,
      updateDirectory,
      version: "0.1.100",
      publishedAt: "2026-08-14T09:00:00Z",
    });
    await assert.rejects(
      stageMacosUpdate({
        ...first,
        updateDirectory,
        version: "0.1.100",
        publishedAt: "2026-08-14T09:00:01Z",
      }),
      /invalid or newer/,
    );
    const secondBytes = Buffer.from("second signed artifact");
    const second = await inputs(root, secondBytes, "-second");
    const result = await stageMacosUpdate({
      ...second,
      updateDirectory,
      version: "0.1.101",
      publishedAt: "2026-08-14T09:01:00Z",
    });

    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.deepEqual(manifest, {
      schemaVersion: 1,
      version: "0.1.101",
      notes: "Local QA build.",
      pubDate: "2026-08-14T09:01:00Z",
      artifactFile: "WTS_0.1.101_aarch64.app.tar.gz",
      signature,
      sha256: createHash("sha256").update(secondBytes).digest("hex"),
      size: secondBytes.length,
    });
    assert.equal((await lstat(result.artifactPath)).isFile(), true);
    assert.deepEqual(
      (await readdir(updateDirectory)).sort(),
      ["WTS_0.1.101_aarch64.app.tar.gz", "latest.json"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid and symlinked publisher inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "wts-update-reject-"));
  try {
    const updateDirectory = join(root, "updates");
    const regular = await inputs(root, "signed artifact");
    await assert.rejects(
      stageMacosUpdate({
        ...regular,
        updateDirectory,
        version: "01.2.3",
        publishedAt: "2026-08-14T09:00:00Z",
      }),
      /bounded semantic version/,
    );
    await writeFile(regular.signatureFile, "not a signature!\n");
    await assert.rejects(
      stageMacosUpdate({
        ...regular,
        updateDirectory,
        version: "0.1.2",
        publishedAt: "2026-08-14T09:00:00Z",
      }),
      /signature is invalid/,
    );

    const outside = join(root, "outside-artifact");
    const linked = join(root, "linked-artifact");
    await writeFile(outside, "do not stage this");
    await symlink(outside, linked);
    await writeFile(regular.signatureFile, `${signature}\n`);
    await assert.rejects(
      stageMacosUpdate({
        artifact: linked,
        signatureFile: regular.signatureFile,
        updateDirectory,
        version: "0.1.2",
        publishedAt: "2026-08-14T09:00:00Z",
      }),
      /artifact must be a regular file/,
    );
    assert.equal(await readFile(outside, "utf8"), "do not stage this");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
