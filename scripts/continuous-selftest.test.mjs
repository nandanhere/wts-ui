import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = resolve(import.meta.dirname, "..");

async function readProjectFile(path) {
  return readFile(join(projectRoot, path), "utf8");
}

test("continuous test shell entrypoints have valid Bash syntax", () => {
  for (const path of [
    "scripts/test-fast.sh",
    "scripts/test-pr.sh",
    "scripts/run-selfhost-e2e.sh",
    "scripts/start-selfhost-e2e-server.sh",
  ]) {
    const result = spawnSync("bash", ["-n", path], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${path}: ${result.stderr}`);
  }
});

test("CI keeps the critical browser path on PRs and self-hosting off the PR gate", async () => {
  const pullRequest = await readProjectFile(
    ".github/workflows/pull-request.yml",
  );
  assert.match(pullRequest, /pull_request:/);
  assert.match(pullRequest, /bash scripts\/test-pr\.sh/);
  assert.match(pullRequest, /playwright install --with-deps chromium/);
  assert.match(pullRequest, /libwebkit2gtk-4\.1-dev/);
  assert.match(pullRequest, /libayatana-appindicator3-dev/);
  assert.match(pullRequest, /if: failure\(\)/);
  assert.match(pullRequest, /ui\/test-results/);

  const prScript = await readProjectFile("scripts/test-pr.sh");
  assert.match(prScript, /playwright test critical-path\.spec\.ts/);
  assert.match(prScript, /--config ui\/playwright\.config\.ts/);
  assert.doesNotMatch(prScript, /run-selfhost-e2e/);
  assert.doesNotMatch(pullRequest, /run-selfhost-e2e/);

  const fastScript = await readProjectFile("scripts/test-fast.sh");
  assert.match(fastScript, /--test wts_report_cli/);
  assert.match(
    fastScript,
    /materializes_once_and_opens_only_the_generated_vscode_workspace/,
  );
  assert.match(
    fastScript,
    /discovers_and_runs_a_persisted_workspace_verification_plan/,
  );
  assert.match(
    fastScript,
    /graph_agent_and_jira_adapter_routes_return_real_wire_contracts/,
  );
});

test("nightly self-host workflow is scheduled, manual, and release-capable", async () => {
  const selfHost = await readProjectFile(
    ".github/workflows/wts-on-wts.yml",
  );
  assert.match(selfHost, /schedule:/);
  assert.match(selfHost, /workflow_dispatch:/);
  assert.match(selfHost, /release:/);
  assert.match(selfHost, /bash scripts\/run-selfhost-e2e\.sh/);
  assert.match(selfHost, /WTS_SELFHOST_E2E_EVIDENCE_DIR/);
  assert.match(selfHost, /if: failure\(\)/);
  assert.match(selfHost, /artifacts\/selfhost-evidence/);
  assert.match(selfHost, /ui\/playwright-report/);
});

test("failed self-host runs redact evidence and remove their isolated runtime", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "wts-selftest-contract-"));
  const fakeBin = join(fixtureRoot, "bin");
  const evidenceRoot = join(fixtureRoot, "evidence");
  const disposableRoot = join(fixtureRoot, "wts-selfhost-e2e.contract");
  const fakeNpx = join(fakeBin, "npx");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(
    fakeNpx,
    `#!/usr/bin/env bash
set -euo pipefail
runtime_root="${disposableRoot}"
mkdir -p "$runtime_root/workspaces/wts/.wts/logs"
printf '%s\\n' "$runtime_root" > "$WTS_SELFHOST_E2E_RUNTIME_MARKER"
printf '%s\\n' '{"schemaVersion":1,"workspaceId":"ws-test","workspacePath":"${disposableRoot}/workspaces/wts","originUrl":"https://github.example/wts/ui","remoteUrl":"https://oauth:super-secret@example.invalid/wts/ui?private=yes","apiToken":"super-secret"}' > "$runtime_root/workspaces/wts/.wts/context.json"
printf '%s\\n' '{"secret":"must-not-be-copied"}' > "$runtime_root/workspaces/wts/.wts/logs/private.json"
exit 7
`,
    { mode: 0o755 },
  );

  const result = spawnSync("bash", ["scripts/run-selfhost-e2e.sh"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      TMPDIR: fixtureRoot,
      WTS_SELFHOST_E2E_EVIDENCE_DIR: evidenceRoot,
    },
  });
  assert.equal(result.status, 7, result.stderr);
  await assert.rejects(readdir(disposableRoot), { code: "ENOENT" });

  const runs = await readdir(evidenceRoot);
  assert.equal(runs.length, 1);
  const bundleRoot = join(evidenceRoot, runs[0]);
  const bundleFiles = await readdir(bundleRoot);
  assert.deepEqual(
    bundleFiles.sort(),
    ["01-context.json", "manifest.json"],
  );
  const captured = await readFile(
    join(bundleRoot, "01-context.json"),
    "utf8",
  );
  assert.doesNotMatch(captured, /super-secret/);
  assert.doesNotMatch(captured, new RegExp(disposableRoot));
  assert.match(captured, /\[redacted\]/);
  assert.match(captured, /\[selfhost-runtime\]/);
  assert.match(captured, /https:\/\/github\.example\/wts\/ui/);
  assert.match(captured, /https:\/\/example\.invalid\/wts\/ui/);
  assert.doesNotMatch(captured, /private=yes/);

  const manifest = JSON.parse(
    await readFile(join(bundleRoot, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.bounded, true);
  assert.equal(manifest.redacted, true);
  assert.equal(manifest.files.length, 1);
});
