import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const auditScript = join(projectRoot, "scripts/check-open-source-readiness.mjs");

function repository(files) {
  const root = mkdtempSync(join(tmpdir(), "wts-public-audit-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  for (const [file, content] of Object.entries(files)) {
    const destination = join(root, file);
    mkdirSync(resolve(destination, ".."), { recursive: true });
    writeFileSync(destination, content);
  }
  return root;
}

function audit(root) {
  return spawnSync(process.execPath, [auditScript, "--root", root], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

test("accepts public fixtures and example paths", () => {
  const root = repository({
    ".env.example": "TOKEN=replace-me\n",
    "README.md": "Use /Users/example/repositories or /home/runner/work.\n",
  });

  const result = audit(root);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /audit passed/);
});

test("rejects generated data, personal paths, and credential-like values", () => {
  const personalPath = ["", "Users", "alice.smith", "private"].join("/");
  const credential = ["gh", "p_", "1234567890abcdefghijkl"].join("");
  const privateEmail = ["developer", "corp", "internal.dev"].join("@").replace(
    "corp@internal",
    "corp.internal",
  );
  const secretAssignment = ["OPENAI_API", "KEY=", "live-value-123456"].join("_");
  const root = repository({
    "graphify-out/graph.json": "{}\n",
    "notes.txt": `${personalPath}\n${credential}\n${privateEmail}\n${secretAssignment}\n`,
  });

  const result = audit(root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /graphify-out\/graph\.json:1/);
  assert.match(result.stderr, /personal macOS path/);
  assert.match(result.stderr, /credential-like value/);
  assert.match(result.stderr, /non-example email address/);
  assert.match(result.stderr, /secret environment assignment/);
  assert.doesNotMatch(result.stderr, /1234567890abcdefghijkl/);
});
