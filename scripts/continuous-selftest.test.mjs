import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = resolve(import.meta.dirname, "..");

async function readProjectFile(path) {
  return readFile(join(projectRoot, path), "utf8");
}

const desktopContractArguments = [
  "--test",
  "scripts/prepare-desktop-dev.test.mjs",
  "scripts/install-macos-app.test.mjs",
  "scripts/stage-macos-update.test.mjs",
];

const browserGateArguments = [
  "--prefix", "ui", "exec", "--", "playwright", "test",
  "critical-path.spec.ts",
  "responsive-polish.spec.ts",
  "workspace-board-dnd.spec.ts",
  "--config", "ui/playwright.config.ts",
];

const directedBrowserGateArguments = [
  "--prefix", "ui", "exec", "--", "playwright", "test",
  "--config", "ui/playwright.feedback.config.ts",
];

const attentionBrowserGateArguments = [
  "--prefix", "ui", "exec", "--", "playwright", "test",
  "--config", "ui/playwright.attention.config.ts",
];

const performanceBrowserGateArguments = [
  "--prefix", "ui", "exec", "--", "playwright", "test",
  "--config", "ui/playwright.performance.config.ts",
];

const renderedPreviewGateArguments = [
  "test", "--locked", "-p", "wts-app", "--lib",
  "installed_vite_serves_candidate_files_and_hot_updates",
  "--", "--ignored", "--nocapture",
];

async function runGitlabGate(t, mode, options = {}) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "wts-gitlab-contract-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const fakeBin = join(fixtureRoot, "bin");
  const commandLog = join(fixtureRoot, "commands.jsonl");
  await mkdir(fakeBin);
  await mkdir(join(fixtureRoot, "scripts"));
  await writeFile(commandLog, "");
  for (const script of ["test-gitlab.sh", "test-fast.sh", "test-pr.sh", "test-macos.sh"]) {
    await copyFile(join(projectRoot, "scripts", script), join(fixtureRoot, "scripts", script));
  }
  const fakeExecutable = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const rustInstaller = '#!/bin/sh\\nexec "$WTS_CI_FAKE_BIN/rustup-init" "$@"\\n';
fs.appendFileSync(process.env.WTS_CI_COMMAND_LOG, JSON.stringify({ command, args, cwd: process.cwd(), cargoHome: process.env.CARGO_HOME, rustupHome: process.env.RUSTUP_HOME, toolchain: process.env.RUSTUP_TOOLCHAIN, home: process.env.HOME }) + "\\n");
if (JSON.stringify({ command, args }) === process.env.WTS_CI_FAILED_COMMAND) process.exit(42);
if (command === "uname") console.log(args[0] === "-s" ? process.env.WTS_CI_FIXTURE_OS : process.env.WTS_CI_FIXTURE_ARCH);
if (command === "node" && args[0] === "--version") console.log("v22.13.1");
if (command === "rustc") console.log("rustc 1.95.0 (fixture)");
if (command === "chmod") fs.chmodSync(args.at(-1), 0o755);
if (command === "curl") {
  const output = args[args.indexOf("--output") + 1];
  const url = args[args.length - 1];
  if (url.endsWith("SHASUMS256.txt")) {
    const archive = process.env.WTS_CI_FIXTURE_OS === "Darwin" ? "node-v22.13.1-darwin-arm64.tar.gz" : "node-v22.13.1-linux-x64.tar.gz";
    const hash = process.env.WTS_CI_BAD_CHECKSUM ? "0".repeat(64) : createHash("sha256").update("node archive fixture").digest("hex");
    fs.writeFileSync(output, hash + "  " + archive + "\\n");
  } else if (url.endsWith(".tar.gz")) {
    fs.writeFileSync(output, "node archive fixture");
  } else if (url.endsWith("rustup-init.sha256")) {
    const hash = process.env.WTS_CI_BAD_RUST_CHECKSUM ? "0".repeat(64) : createHash("sha256").update(rustInstaller).digest("hex");
    fs.writeFileSync(output, hash + "  rustup-init\\n");
  } else {
    fs.writeFileSync(output, rustInstaller);
  }
}
if (command === "rustup-init") {
  const directory = path.join(process.env.CARGO_HOME, "bin");
  fs.mkdirSync(directory, { recursive: true });
  for (const tool of ["cargo", "rustc", "rustup"]) fs.copyFileSync(path.join(process.env.WTS_CI_FAKE_BIN, tool), path.join(directory, tool));
  fs.writeFileSync(process.env.WTS_CI_INSTALLER_ARGS, args.join(" ") + "\\n");
}
if (command === "tar") {
  const directory = args[args.indexOf("-C") + 1];
  fs.mkdirSync(path.join(directory, "bin"), { recursive: true });
  for (const tool of ["node", "npm"]) fs.copyFileSync(path.join(process.env.WTS_CI_FAKE_BIN, tool), path.join(directory, "bin", tool));
}
`;
  for (const command of ["uname", "curl", "tar", "chmod", "rustup-init", "rustup", "cargo", "rustc", "node", "npm", "apt-get"]) {
    await writeFile(join(fakeBin, command), fakeExecutable, { mode: 0o755 });
  }
  const result = spawnSync("bash", ["scripts/test-gitlab.sh", mode], {
    cwd: fixtureRoot,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CI_PROJECT_DIR: fixtureRoot,
      WTS_CI_COMMAND_LOG: commandLog,
      WTS_CI_FAKE_BIN: fakeBin,
      WTS_CI_INSTALLER_ARGS: join(fixtureRoot, "installer-args"),
      WTS_CI_FIXTURE_OS: mode === "macos" ? "Darwin" : "Linux",
      WTS_CI_FIXTURE_ARCH: mode === "macos" ? "arm64" : "x86_64",
      WTS_CI_BAD_CHECKSUM: options.badChecksum ? "1" : "",
      WTS_CI_BAD_RUST_CHECKSUM: options.badRustChecksum ? "1" : "",
      WTS_CI_FAILED_COMMAND: JSON.stringify(options.failedCommand ?? null),
    },
  });
  assert.ifError(result.error);
  const commands = (await readFile(commandLog, "utf8"))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { ...result, commands, fixtureRoot };
}

test("GitLab Linux installs isolated tools and runs the complete browser gate", async (t) => {
  const result = await runGitlabGate(t, "linux");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(result.commands.some(({ command, args }) => command === "curl" && args.at(-1).endsWith("node-v22.13.1-linux-x64.tar.gz")));
  assertRustInstallerDownloads(result, "x86_64-unknown-linux-gnu");
  assert.ok(result.commands.some(({ command, args }) => command === "apt-get" && args.includes("libwebkit2gtk-4.1-dev")));
  assert.ok(result.commands.some(({ command, args }) => command === "npm" && args.includes("--with-deps")));
  assert.ok(result.commands.some(({ command, args }) => command === "npm" && JSON.stringify(args) === JSON.stringify(browserGateArguments)));
  for (const invocation of result.commands.filter(({ command }) => command === "cargo")) {
    assert.equal(invocation.cargoHome, join(result.fixtureRoot, ".tools/gitlab-ci/cargo"));
    assert.equal(invocation.rustupHome, join(result.fixtureRoot, ".tools/gitlab-ci/rustup"));
    assert.equal(invocation.toolchain, "1.95.0");
    assert.equal(invocation.home, process.env.HOME);
  }
});

test("GitLab macOS selects ARM tools and preserves host installation defaults", async (t) => {
  const result = await runGitlabGate(t, "macos");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(result.commands.some(({ command, args }) => command === "curl" && args.at(-1).endsWith("node-v22.13.1-darwin-arm64.tar.gz")));
  assertRustInstallerDownloads(result, "aarch64-apple-darwin");
  assert.ok(!result.commands.some(({ command }) => command === "apt-get"));
  assert.ok(!result.commands.some(({ command, args }) => command === "rustup" && args[0] === "default"));
  const installerArgs = await readFile(join(result.fixtureRoot, "installer-args"), "utf8");
  assert.match(installerArgs, /--no-modify-path/);
  assert.match(installerArgs, /--default-toolchain none/);
  assert.ok(result.commands.some(({ command, args }) => command === "cargo" && JSON.stringify(args) === JSON.stringify(["build", "--locked", "-p", "wts-desktop"])));
  assert.ok(!result.commands.some(({ args }) => args.includes("playwright")));
});

function assertRustInstallerDownloads(result, host) {
  const base = `https://static.rust-lang.org/rustup/dist/${host}/rustup-init`;
  const downloads = result.commands.filter(({ command }) => command === "curl");
  assert.deepEqual(downloads.filter(({ args }) => args.at(-1).includes("rustup")).map(({ args }) => args.at(-1)), [base, `${base}.sha256`]);
  const installerIndex = result.commands.findIndex(({ command }) => command === "rustup-init");
  const checksumIndex = result.commands.findIndex(({ command, args }) => command === "curl" && args.at(-1) === `${base}.sha256`);
  assert.ok(checksumIndex >= 0 && installerIndex > checksumIndex);
  assert.deepEqual(result.commands[installerIndex].args, ["-y", "--no-modify-path", "--default-toolchain", "none", "--profile", "minimal"]);
}

test("GitLab rejects a mismatched Node archive before extraction or execution", async (t) => {
  const result = await runGitlabGate(t, "macos", { badChecksum: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /checksum does not match/);
  assert.ok(!result.commands.some(({ command }) => ["tar", "node", "cargo", "npm"].includes(command)));
});

test("GitLab rejects a mismatched Rust installer before execution", async (t) => {
  const result = await runGitlabGate(t, "macos", { badRustChecksum: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Rust installer checksum does not match/);
  assert.ok(!result.commands.some(({ command }) => ["chmod", "rustup-init", "rustup", "rustc", "cargo", "npm"].includes(command)));
  await assert.rejects(readFile(join(result.fixtureRoot, "installer-args")), { code: "ENOENT" });
});

test("GitLab retains failure output and fails when a native contract fails", async (t) => {
  const result = await runGitlabGate(t, "macos", {
    failedCommand: { command: "node", args: desktopContractArguments },
  });
  assert.equal(result.status, 42, result.stderr || result.stdout);
  const log = await readFile(join(result.fixtureRoot, "artifacts/ci/macos.log"), "utf8");
  assert.match(log, /WTS macOS gate: FAILED/);
  assert.ok(!result.commands.some(({ command, args }) => command === "cargo" && args[0] === "build"));
});

test("GitLab gates use the available runners and accept only MR or web pipelines", async () => {
  const config = await readProjectFile(".gitlab-ci.yml");
  assert.deepEqual([...config.matchAll(/\$CI_PIPELINE_SOURCE == "([^"]+)"/g)].map((match) => match[1]), ["merge_request_event", "web"]);
  assert.match(config, /workflow:\n  rules:[\s\S]*?- when: never/);
  assert.match(config, /when: on_failure/);
  assert.match(config, /expire_in: 14 days/);
  assert.match(config, /ui\/test-results/);
  assert.match(config, /artifacts\/ci/);
  const linux = config.match(/^linux-gate:\n[\s\S]*?(?=^macos-native:)/m)?.[0];
  const macos = config.match(/^macos-native:\n[\s\S]*/m)?.[0];
  assert.match(linux ?? "", /image: debian:bookworm-slim/);
  assert.match(linux ?? "", /backend-docker-large/);
  assert.match(linux ?? "", /bash scripts\/test-gitlab\.sh linux/);
  assert.match(macos ?? "", /mac-vm-large/);
  assert.match(macos ?? "", /bash scripts\/test-gitlab\.sh macos/);
});

async function runGate(t, entrypoint, failedCommand = null) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "wts-gate-contract-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const fakeBin = join(fixtureRoot, "bin");
  const commandLog = join(fixtureRoot, "commands.jsonl");
  await mkdir(fakeBin);
  await writeFile(commandLog, "");
  const fakeExecutable = `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { basename } = require("node:path");
const invocation = { command: basename(process.argv[1]), args: process.argv.slice(2) };
appendFileSync(process.env.WTS_GATE_COMMAND_LOG, JSON.stringify({ ...invocation, cwd: process.cwd() }) + "\\n");
if (JSON.stringify(invocation) === process.env.WTS_GATE_FAILED_COMMAND) process.exit(42);
`;
  for (const command of ["cargo", "node", "npm"]) {
    await writeFile(join(fakeBin, command), fakeExecutable, { mode: 0o755 });
  }

  const result = spawnSync("bash", [entrypoint], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      WTS_GATE_COMMAND_LOG: commandLog,
      WTS_GATE_FAILED_COMMAND: JSON.stringify(failedCommand),
    },
  });
  assert.ifError(result.error);
  const commands = (await readFile(commandLog, "utf8"))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { ...result, commands };
}

test("the fast gate executes desktop setup, installation, and update contracts", async (t) => {
  const result = await runGate(t, "scripts/test-fast.sh");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.commands.some(({ command, args }) =>
    command === "node" && JSON.stringify(args) === JSON.stringify(desktopContractArguments),
  ), "The fast gate must execute all three desktop contract suites.");
});

test("the fast gate limits the React suite to two UI workers", async (t) => {
  const result = await runGate(t, "scripts/test-fast.sh");
  assert.equal(result.status, 0, result.stderr);
  const invocation = result.commands.find(({ command, args }) => command === "npm" && args[2] === "test");
  assert.ok(invocation, "The fast gate must execute the React suite.");
  assert.deepEqual(invocation.args, ["--prefix", "ui", "test", "--", "--maxWorkers=2", "--minWorkers=1"]);
});

test("the PR gate executes critical, responsive, and board browser tests after the UI build", async (t) => {
  const result = await runGate(t, "scripts/test-pr.sh");
  assert.equal(result.status, 0, result.stderr);
  const browserIndex = result.commands.findIndex(({ command, args }) =>
    command === "npm" && JSON.stringify(args) === JSON.stringify(browserGateArguments),
  );
  assert.notEqual(browserIndex, -1, "The PR gate must execute all three browser suites.");
  assert.equal(result.commands[browserIndex].cwd, projectRoot);
  const buildIndex = result.commands.findIndex(({ command, args }) =>
    command === "npm" && JSON.stringify(args) === JSON.stringify(["--prefix", "ui", "run", "build"]),
  );
  assert.ok(buildIndex >= 0 && buildIndex < browserIndex);
});

test("a failed desktop contract stops the PR gate before browser tests", async (t) => {
  const result = await runGate(t, "scripts/test-pr.sh", {
    command: "node", args: desktopContractArguments,
  });
  assert.equal(result.status, 42, result.stderr);
  assert.match(result.stderr, /WTS fast gate: FAILED/);
  assert.match(result.stderr, /WTS pull-request gate: FAILED/);
  assert.ok(!result.commands.some(({ args }) => args.includes("playwright")));
  assert.doesNotMatch(result.stdout, /WTS pull-request gate: PASSED/);
});

test("a failed browser suite fails the PR gate", async (t) => {
  const result = await runGate(t, "scripts/test-pr.sh", {
    command: "npm", args: browserGateArguments,
  });
  assert.equal(result.status, 42, result.stderr);
  assert.match(result.stderr, /WTS pull-request gate: FAILED/);
  assert.doesNotMatch(result.stdout, /WTS pull-request gate: PASSED/);
});

test("the PR gate executes directed browser flows and the rendered preview after existing checks", async (t) => {
  const result = await runGate(t, "scripts/test-pr.sh");
  assert.equal(result.status, 0, result.stderr);
  const indexOf = (command, args) => result.commands.findIndex(invocation =>
    invocation.command === command && JSON.stringify(invocation.args) === JSON.stringify(args),
  );
  const existing = indexOf("npm", browserGateArguments);
  const directed = indexOf("npm", directedBrowserGateArguments);
  const preview = indexOf("cargo", renderedPreviewGateArguments);
  assert.ok(existing >= 0 && directed > existing, "The PR gate must run the directed browser config after existing browser checks.");
  assert.ok(preview > directed, "The PR gate must execute the installed-Vite browser boundary.");
  assert.equal(result.commands[directed].cwd, projectRoot);
  assert.equal(result.commands[preview].cwd, projectRoot);
});

for (const [name, command, args] of [
  ["directed browser", "npm", directedBrowserGateArguments],
  ["rendered candidate preview", "cargo", renderedPreviewGateArguments],
]) {
  test(`a failed ${name} check fails the PR gate`, async (t) => {
    const result = await runGate(t, "scripts/test-pr.sh", { command, args });
    assert.equal(result.status, 42, result.stderr || result.stdout);
    assert.match(result.stderr, /WTS pull-request gate: FAILED/);
    assert.doesNotMatch(result.stdout, /WTS pull-request gate: PASSED/);
  });
}

test("the PR gate executes attention and performance browser checks after directed flows", async (t) => {
  const result = await runGate(t, "scripts/test-pr.sh");
  assert.equal(result.status, 0, result.stderr);
  const indexOf = (command, args) => result.commands.findIndex(invocation =>
    invocation.command === command && JSON.stringify(invocation.args) === JSON.stringify(args),
  );
  const directed = indexOf("npm", directedBrowserGateArguments);
  const attention = indexOf("npm", attentionBrowserGateArguments);
  const performance = indexOf("npm", performanceBrowserGateArguments);
  const preview = indexOf("cargo", renderedPreviewGateArguments);
  assert.ok(directed >= 0 && attention > directed, "The PR gate must execute the attention browser checks.");
  assert.ok(performance > attention, "The PR gate must execute the request budgets after attention checks.");
  assert.ok(preview > performance, "The preview check must follow the request budgets.");
  assert.equal(result.commands[attention].cwd, projectRoot);
  assert.equal(result.commands[performance].cwd, projectRoot);
});

for (const [name, args, nextCommand, nextArgs] of [
  ["attention browser", attentionBrowserGateArguments, "npm", performanceBrowserGateArguments],
  ["performance browser", performanceBrowserGateArguments, "cargo", renderedPreviewGateArguments],
]) {
  test(`a failed ${name} check stops the PR gate before later checks`, async (t) => {
    const result = await runGate(t, "scripts/test-pr.sh", { command: "npm", args });
    assert.equal(result.status, 42, result.stderr || result.stdout);
    assert.match(result.stderr, /WTS pull-request gate: FAILED/);
    assert.doesNotMatch(result.stdout, /WTS pull-request gate: PASSED/);
    assert.ok(!result.commands.some(invocation => invocation.command === nextCommand && JSON.stringify(invocation.args) === JSON.stringify(nextArgs)));
  });
}

test("the macOS gate builds the UI and executes native tests and the desktop build", async (t) => {
  const result = await runGate(t, "scripts/test-macos.sh");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.commands.map(({ command, args }) => ({ command, args })), [
    { command: "npm", args: ["--prefix", "ui", "run", "build"] },
    { command: "node", args: desktopContractArguments },
    { command: "cargo", args: ["test", "--locked", "-p", "wts-app", "-p", "wts-desktop"] },
    { command: "cargo", args: ["build", "--locked", "-p", "wts-desktop"] },
  ]);
});

test("a failed native test stops the macOS gate before the desktop build", async (t) => {
  const result = await runGate(t, "scripts/test-macos.sh", {
    command: "cargo", args: ["test", "--locked", "-p", "wts-app", "-p", "wts-desktop"],
  });
  assert.equal(result.status, 42, result.stderr);
  assert.match(result.stderr, /WTS macOS gate: FAILED/);
  assert.ok(!result.commands.some(({ command, args }) => command === "cargo" && args[0] === "build"));
});

test("continuous test shell entrypoints have valid Bash syntax", () => {
  for (const path of [
    "scripts/test-fast.sh",
    "scripts/test-pr.sh",
    "scripts/test-macos.sh",
    "scripts/test-gitlab.sh",
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

test("PRs run native contracts on a macOS runner", async () => {
  const pullRequest = await readProjectFile(".github/workflows/pull-request.yml");
  const macosJob = pullRequest.match(/^  macos-native:\n[\s\S]*?(?=^  [\w-]+:\n|$(?![\s\S]))/m)?.[0];
  assert.ok(macosJob, "The PR workflow must define a macOS job.");
  assert.match(macosJob, /runs-on: macos-/);
  assert.match(macosJob, /uses: actions\/checkout@/);
  assert.match(macosJob, /uses: actions\/setup-node@/);
  assert.match(macosJob, /uses: dtolnay\/rust-toolchain@/);
  assert.match(macosJob, /run: npm ci --prefix ui/);
  assert.match(macosJob, /run: bash scripts\/test-macos\.sh/);
});

test("the UI installation supplies Node types without parent dependencies", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "wts-ui-node-types-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const source = join(fixtureRoot, "node-contract.ts");
  await writeFile(source, `
import { readFileSync } from "node:fs";
import { join } from "node:path";
const file: string = join(__dirname, "fixture.txt");
const contents: string = readFileSync(file, "utf8");
const suffix: string | undefined = process.env.WTS_TYPE_CONTRACT;
process.stdout.write(contents + (suffix ?? ""));
`);
  const compile = (typeRoot) => spawnSync(process.execPath, [
    join(projectRoot, "ui/node_modules/typescript/bin/tsc"),
    "--noEmit", "--strict", "--target", "ES2022",
    "--module", "ESNext", "--moduleResolution", "Bundler",
    "--types", "node", "--typeRoots", typeRoot, source,
  ], { cwd: fixtureRoot, encoding: "utf8", timeout: 20_000 });

  const emptyTypes = join(fixtureRoot, "missing-ui-types");
  await mkdir(emptyTypes);
  const missing = compile(emptyTypes);
  assert.ifError(missing.error);
  assert.equal(missing.status, 2, missing.stderr || missing.stdout);
  assert.match(missing.stdout, /TS2688: Cannot find type definition file for 'node'/);

  const installed = compile(join(projectRoot, "ui/node_modules/@types"));
  assert.ifError(installed.error);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
});

test("the Rust minimum and CI toolchains support the locked SQLite dependencies", async () => {
  const manifest = await readProjectFile("Cargo.toml");
  const minimum = /^rust-version = "([^"]+)"$/m.exec(manifest)?.[1];
  assert.equal(minimum, "1.95");
  const readme = await readProjectFile("README.md");
  assert.match(readme, /Rust 1\.95 or later/);
  const gitlabSetup = await readProjectFile("scripts/test-gitlab.sh");
  assert.match(gitlabSetup, new RegExp(`^rust_version="${minimum.replaceAll(".", "\\.")}\\.0"$`, "m"));

  const metadataResult = spawnSync("cargo", [
    "metadata", "--locked", "--offline", "--no-deps", "--format-version", "1",
  ], { cwd: projectRoot, encoding: "utf8", timeout: 10_000 });
  assert.equal(metadataResult.status, 0, metadataResult.stderr);
  const metadata = JSON.parse(metadataResult.stdout);
  for (const member of metadata.packages) {
    if (metadata.workspace_members.includes(member.id)) {
      assert.equal(member.rust_version, minimum, member.name);
    }
  }

  for (const workflow of [
    ".github/workflows/pull-request.yml",
    ".github/workflows/wts-on-wts.yml",
  ]) {
    const source = await readProjectFile(workflow);
    const toolchains = [...source.matchAll(/^\s+toolchain: (\S+)$/gm)];
    assert.ok(toolchains.length > 0, `${workflow} must select a Rust toolchain.`);
    for (const [, version] of toolchains) {
      assert.equal(version, `${minimum}.0`, workflow);
    }
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
