import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deterministicGitEnvironment } from "./run-node-tests.mjs";

test("isolates temporary commits from personal Git identity and signing", () => {
  const root = mkdtempSync(join(tmpdir(), "wts-git-test-env-"));
  const hostileConfig = join(root, "hostile-gitconfig");
  const hostileEmail = ["private", "company", "internal"].join("@").replace(
    "company@internal",
    "company.internal",
  );
  writeFileSync(
    hostileConfig,
    `[user]\n\tname = Private User\n\temail = ${hostileEmail}\n[commit]\n\tgpgsign = true\n`,
  );
  const environment = deterministicGitEnvironment({
    ...process.env,
    GIT_CONFIG_GLOBAL: hostileConfig,
  });

  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: root,
    env: environment,
  });
  writeFileSync(join(root, "README.md"), "# Test\n");
  execFileSync("git", ["add", "README.md"], { cwd: root, env: environment });
  execFileSync("git", ["commit", "--quiet", "-m", "test"], {
    cwd: root,
    env: environment,
  });

  const author = execFileSync("git", ["show", "-s", "--format=%an <%ae>"], {
    cwd: root,
    env: environment,
    encoding: "utf8",
  }).trim();
  assert.equal(author, "WTS Tests <wts-tests@example.invalid>");
});
