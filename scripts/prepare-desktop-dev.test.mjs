import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = resolve(import.meta.dirname, "..");

test("desktop development setup installs a runnable wts-report on the configured PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "wts-report-dev-"));
  const bin = join(root, "bin");
  try {
    const setup = spawnSync("bash", ["scripts/prepare-desktop-dev.sh"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        WTS_DEV_BIN_DIR: bin,
      },
      encoding: "utf8",
    });
    assert.equal(setup.status, 0, setup.stderr || setup.stdout);

    const shell = spawnSync(
      "bash",
      ["-c", 'command -v wts-report && wts-report --help'],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          PATH: `${bin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      },
    );
    assert.equal(shell.status, 0, shell.stderr || shell.stdout);
    assert.match(shell.stdout, new RegExp(`${bin}/wts-report`));
    assert.match(shell.stdout, /Usage: wts-report \[--input PATH\]/);

    const rustc = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
    assert.equal(rustc.status, 0, rustc.stderr);
    const target = /^host: (.+)$/m.exec(rustc.stdout)?.[1];
    assert.ok(target, "rustc did not report its host target");
    const sidecar = await stat(
      join(projectRoot, "src-tauri", "binaries", `wts-report-${target}`),
    );
    assert.ok(sidecar.isFile());
    assert.notEqual(sidecar.mode & 0o111, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
