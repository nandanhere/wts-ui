import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const [action, manifestPath] = process.argv.slice(2);
assert.ok(["build", "launch"].includes(action), "Use build or launch with the generated fixture.json path.");
assert.equal(process.platform, "darwin", "This fixture uses the macOS desktop host.");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const root = await realpath(manifest.root);
assert.equal(root, await realpath(dirname(manifestPath)));
assert.ok(basename(root).startsWith("wts-native-candidate-"));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.activeOrQueuedTasks, 0);
assert.equal(manifest.fakeProviderLaunches, 3);
for (const value of [manifest.source, manifest.target, manifest.denyBin, manifest.nativeConfig,
  manifest.nativeTargetDirectory, ...Object.values(manifest.environment)]) {
  const within = relative(root, value);
  assert.ok(within && !within.startsWith("..") && !isAbsolute(within), "Fixture paths must stay inside the temporary directory.");
}
const config = JSON.parse(await readFile(manifest.nativeConfig, "utf8"));
assert.ok(config.identifier.startsWith("dev.wts.nativefixture."));
assert.equal(config.app.windows[0].incognito, true);
assert.equal(config.build.devUrl, manifest.origin);
const environment = {
  ...process.env, ...manifest.environment,
  PATH: [manifest.denyBin, dirname(manifest.node), process.env.PATH].join(":"),
  TAURI_CONFIG: JSON.stringify(config),
  CARGO_TARGET_DIR: manifest.nativeTargetDirectory,
  CARGO_BUILD_JOBS: "4",
};
const appBundle = join(root, "WTS Native Fixture.app");
const executable = join(appBundle, "Contents/MacOS/wts-native-fixture");

async function command(program, args, options = {}) {
  const child = spawn(program, args, { cwd: manifest.project, env: environment, stdio: "inherit", ...options });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(status, 0, `${program} did not complete.`);
}

if (action === "build") {
  if (process.env.WTS_NATIVE_FIXTURE_CLONE_CACHE === "1") {
    await assert.rejects(lstat(manifest.nativeTargetDirectory), { code: "ENOENT" });
    await command("/bin/cp", ["-cR", join(manifest.project, "target"), manifest.nativeTargetDirectory]);
  }
  await command("cargo", ["build", "--locked", "-p", "wts-desktop"]);
  await mkdir(dirname(executable), { recursive: true });
  await copyFile(join(manifest.nativeTargetDirectory, "debug/wts-desktop"), executable);
  await chmod(executable, 0o755);
  await writeFile(join(appBundle, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${config.identifier}</string>
<key>CFBundleExecutable</key><string>wts-native-fixture</string>
<key>CFBundleName</key><string>WTS Native Fixture</string>
<key>CFBundleDisplayName</key><string>WTS Native Fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`);
  await command("/usr/bin/codesign", ["--force", "--sign", "-", appBundle]);
  console.log(`Fixture build ready. No app started: ${appBundle}`);
} else {
  assert.equal(process.env.WTS_NATIVE_FIXTURE_LAUNCH, "1", "Set WTS_NATIVE_FIXTURE_LAUNCH=1 only after fixture review.");
  const require = createRequire(join(manifest.project, "ui/package.json"));
  const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
  const { default: react } = await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href);
  const server = await createServer({
    configFile: false,
    root: join(manifest.source, "ui"),
    cacheDir: join(root, "main-vite-cache"),
    plugins: [react(), {
      name: "native-fixture-no-http-provider",
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (!request.url?.startsWith("/api/")) return next();
          response.statusCode = 503;
          response.end("Use the isolated native fixture host.");
        });
      },
    }],
    server: { host: "127.0.0.1", port: manifest.port, strictPort: true },
  });
  await server.listen();
  const child = spawn(executable, [], { cwd: root, env: environment, stdio: "inherit" });
  const stop = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    console.log(JSON.stringify({ nativeFixturePid: child.pid, appBundle, origin: manifest.origin, manifestPath }));
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    process.exitCode = status ?? 0;
  } finally {
    stop();
    await server.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
