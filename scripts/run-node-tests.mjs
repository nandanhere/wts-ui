import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function deterministicGitEnvironment(baseEnvironment = process.env) {
  return {
    ...baseEnvironment,
    GIT_AUTHOR_EMAIL: "wts-tests@example.invalid",
    GIT_AUTHOR_NAME: "WTS Tests",
    GIT_COMMITTER_EMAIL: "wts-tests@example.invalid",
    GIT_COMMITTER_NAME: "WTS Tests",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_VALUE_0: "false",
  };
}

function main() {
  const argumentsForNode = [
    "--experimental-strip-types",
    "--loader",
    "./scripts/register-ts.mjs",
    "--test",
    "scripts/run-node-tests.test.mjs",
    "src/lib/workspace/__tests__/*.test.ts",
    "src/lib/git/__tests__/*.ts",
    "src/lib/snapshot/__tests__/*.test.ts",
    "src/lib/config-inventory/__tests__/*.test.ts",
    "src/app/api/snapshots/__tests__/*.test.ts",
    "src/lib/api/workspace.test.ts",
    "src/lib/api/git.test.ts",
    "src/lib/api/git-actions.test.ts",
    "src/lib/graphify/__tests__/*.test.ts",
    "src/lib/api/graphify.test.ts",
    "src/components/graphify/*.test.ts",
    "src/components/workspace/workspace-summary.test.ts",
    "src/lib/api/__tests__/snapshots.test.ts",
    "src/lib/api/__tests__/deployments.test.ts",
    "src/lib/integrations/__tests__/*.test.ts",
    "src/lib/api/__tests__/integrations.test.ts",
    "src/app/api/integrations/__tests__/*.test.ts",
  ];
  const result = spawnSync(process.execPath, argumentsForNode, {
    cwd: projectRoot,
    env: deterministicGitEnvironment(),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
