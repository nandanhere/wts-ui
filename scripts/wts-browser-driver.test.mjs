import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { chromium } from "playwright";
import {
  redactEvidenceText,
  redactRequestUrl,
  serializeResultJson,
} from "./wts-browser-driver.mjs";

const execFileAsync = promisify(execFile);
const DRIVER_PATH = path.resolve("scripts/wts-browser-driver.mjs");

async function browserIsAvailable() {
  try {
    await access(chromium.executablePath());
    return true;
  } catch {
    return false;
  }
}

const HAS_BROWSER = await browserIsAvailable();

function basePlan(origin) {
  return {
    schemaVersion: 1,
    runId: "run-1",
    workspaceId: "workspace-1",
    journeyId: "journey-1",
    title: "Synthetic user journey",
    baseUrl: origin,
    allowedOrigins: [origin],
    timeoutMs: 10_000,
    steps: [{ kind: "navigate", path: "/" }],
  };
}

async function makeRunDirectory(t) {
  const created = await mkdtemp(path.join(os.tmpdir(), "wts-browser-driver-"));
  const runDirectory = await realpath(created);
  const artifactsPath = path.join(runDirectory, "artifacts");
  await mkdir(artifactsPath, { mode: 0o700 });
  const outputPath = path.join(runDirectory, "result.json");
  await writeFile(outputPath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  t.after(async () => {
    await rm(runDirectory, { recursive: true, force: true });
  });
  return {
    runDirectory,
    artifactsPath,
    planPath: path.join(runDirectory, "plan.json"),
    outputPath,
  };
}

async function invokeDriver(paths, plan, extraArguments = []) {
  await writeFile(paths.planPath, `${JSON.stringify(plan)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  const argumentsList = [
    DRIVER_PATH,
    "--plan",
    paths.planPath,
    "--artifacts",
    paths.artifactsPath,
    "--output",
    paths.outputPath,
    ...extraArguments,
  ];
  try {
    const result = await execFileAsync(process.execPath, argumentsList, {
      cwd: path.resolve("."),
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : null,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function readResult(paths) {
  return JSON.parse(await readFile(paths.outputPath, "utf8"));
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

function target(kind, value) {
  if (kind === "role") {
    const [role, name] = value;
    return { kind, role, name, exact: true };
  }
  if (kind === "testId") {
    return { kind, value };
  }
  return { kind, value, exact: true };
}

test("rejects unknown fields, external origins, absolute navigation, and duplicate origins", async (t) => {
  const origin = "http://127.0.0.1:41000";
  const invalidPlans = [
    {
      name: "unknown field",
      mutate(plan) {
        plan.untrusted = true;
      },
      pattern: /must contain exactly/,
    },
    {
      name: "external origin",
      mutate(plan) {
        plan.allowedOrigins = [origin, "https://example.com"];
      },
      pattern: /canonical loopback/,
    },
    {
      name: "absolute navigation",
      mutate(plan) {
        plan.steps = [{ kind: "navigate", path: "http://127.0.0.1:41000/" }];
      },
      pattern: /origin-relative path/,
    },
    {
      name: "duplicate origin",
      mutate(plan) {
        plan.allowedOrigins = [origin, origin];
      },
      pattern: /must not contain duplicates/,
    },
    {
      name: "raw selector field",
      mutate(plan) {
        plan.steps = [
          {
            kind: "click",
            target: { kind: "text", value: "Go", exact: true, selector: "#go" },
          },
        ];
      },
      pattern: /must contain exactly/,
    },
    {
      name: "unapproved key chord",
      mutate(plan) {
        plan.steps = [
          {
            kind: "press",
            target: { kind: "label", value: "Name", exact: true },
            key: "Control+A",
          },
        ];
      },
      pattern: /not allowlisted/,
    },
  ];

  for (const invalid of invalidPlans) {
    await t.test(invalid.name, async (nested) => {
      const paths = await makeRunDirectory(nested);
      const plan = basePlan(origin);
      invalid.mutate(plan);
      const execution = await invokeDriver(paths, plan);
      assert.equal(execution.code, 2);
      assert.match(execution.stderr, invalid.pattern);
      assert.equal(await readFile(paths.outputPath, "utf8"), "");
    });
  }
});

test("requires canonical absolute CLI paths", async (t) => {
  const paths = await makeRunDirectory(t);
  const plan = basePlan("http://127.0.0.1:41000");
  await writeFile(paths.planPath, `${JSON.stringify(plan)}\n`);

  const relativePlan = path.relative(path.resolve("."), paths.planPath);
  try {
    await execFileAsync(
      process.execPath,
      [
        DRIVER_PATH,
        "--plan",
        relativePlan,
        "--artifacts",
        paths.artifactsPath,
        "--output",
        paths.outputPath,
      ],
      { cwd: path.resolve("."), timeout: 10_000 },
    );
    assert.fail("driver unexpectedly accepted a relative plan path");
  } catch (error) {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /absolute normalized path/);
  }
});

test("requires a canonical zero-byte output file reserved by WTS", async (t) => {
  await t.test("missing reservation", async (nested) => {
    const paths = await makeRunDirectory(nested);
    await rm(paths.outputPath);
    const execution = await invokeDriver(
      paths,
      basePlan("http://127.0.0.1:41000"),
    );
    assert.equal(execution.code, 2);
    assert.match(execution.stderr, /existing canonical zero-byte regular file/);
    await assert.rejects(access(paths.outputPath));
  });

  await t.test("non-empty reservation", async (nested) => {
    const paths = await makeRunDirectory(nested);
    await writeFile(paths.outputPath, "already claimed", "utf8");
    const execution = await invokeDriver(
      paths,
      basePlan("http://127.0.0.1:41000"),
    );
    assert.equal(execution.code, 2);
    assert.match(execution.stderr, /existing canonical zero-byte regular file/);
    assert.equal(await readFile(paths.outputPath, "utf8"), "already claimed");
  });
});

test("redacts secrets deterministically before bounding evidence text", () => {
  const raw =
    'Authorization: Bearer bearer-value\nCookie: sid=cookie-value\npassword=hunter2 api_key="api-value" client-secret: client-value token=token-value';
  const first = redactEvidenceText(raw, 2_048);
  const second = redactEvidenceText(raw, 2_048);
  assert.equal(first, second);
  assert.match(first, /Authorization: \[REDACTED\]/);
  assert.match(first, /Cookie: \[REDACTED\]/);
  assert.match(first, /password=\[REDACTED\]/);
  assert.match(first, /api_key=\[REDACTED\]/);
  assert.match(first, /client-secret: \[REDACTED\]/);
  assert.match(first, /token=\[REDACTED\]/);
  for (const secret of [
    "bearer-value",
    "cookie-value",
    "hunter2",
    "api-value",
    "client-value",
    "token-value",
  ]) {
    assert(!first.includes(secret));
  }
  assert(Buffer.byteLength(redactEvidenceText("x".repeat(5_000), 128)) <= 128);
});

test("truncates only at complete Unicode code points within the byte budget", () => {
  const retainedEmoji = redactEvidenceText(
    `${"a".repeat(109)}😀${"z".repeat(100)}`,
    128,
  );
  assert.equal(
    retainedEmoji,
    `${"a".repeat(109)}😀\n…[truncated]`,
  );
  assert.equal(Buffer.byteLength(retainedEmoji, "utf8"), 128);
  assert(!retainedEmoji.includes("�"));

  const excludedEmoji = redactEvidenceText(
    `${"a".repeat(110)}😀${"z".repeat(100)}`,
    128,
  );
  assert.equal(excludedEmoji, `${"a".repeat(110)}\n…[truncated]`);
  assert(Buffer.byteLength(excludedEmoji, "utf8") <= 128);
  assert(!excludedEmoji.includes("�"));
});

test("redacts sensitive URL paths and reduces non-HTTP URLs to their scheme", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123";
  const apiToken = "sk-live-AbCdEf0123456789";
  assert.equal(
    redactRequestUrl(
      `https://user:password@127.0.0.1:41000/api/${uuid}/${jwt}/${apiToken}?token=secret#fragment`,
    ),
    "https://127.0.0.1:41000/api/[redacted]/[redacted]/[redacted]?[redacted]",
  );
  assert.equal(
    redactRequestUrl(
      "http://localhost:41000/runs/aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY",
    ),
    "http://localhost:41000/runs/[redacted]",
  );
  assert.equal(
    redactRequestUrl("http://localhost:41000/workspaces/help-and-preferences"),
    "http://localhost:41000/workspaces/help-and-preferences",
  );
  assert.equal(
    redactRequestUrl("data:text/plain,private-content"),
    "data:[redacted]",
  );
  assert.equal(
    redactRequestUrl("file:///Users/example/secret.txt"),
    "file:[redacted]",
  );
  assert.equal(
    redactRequestUrl("ws://127.0.0.1:41000/private"),
    "ws:[redacted]",
  );
});

test("maximum structured evidence remains under Rust's one MiB result limit", () => {
  const eventText = redactEvidenceText("event-line\n".repeat(300), 1_024);
  const errorText = redactEvidenceText("failure-line\n".repeat(300), 1_536);
  const longUrl = redactRequestUrl(
    `http://127.0.0.1:41000/${"a".repeat(2_020)}`,
  );
  const steps = Array.from({ length: 64 }, (_, index) => ({
    index,
    kind: "assertText",
    status: "failed",
    startedAtUnixMs: index,
    completedAtUnixMs: index + 1,
    duration: 1,
    snapshot: `aria/${String(index + 1).padStart(3, "0")}-assertText.aria.yml`,
    screenshot: index < 16 ? `screenshots/${index + 1}.png` : null,
    error: errorText,
  }));
  const denseResult = {
    schemaVersion: 1,
    status: "failed",
    times: { startedAtUnixMs: 1, completedAtUnixMs: 2 },
    duration: 1,
    steps,
    consoleErrors: Array.from({ length: 64 }, () => ({
      type: "error",
      text: eventText,
      timestampUnixMs: 1,
    })),
    requests: Array.from({ length: 96 }, () => ({
      method: "GET",
      url: longUrl,
      status: null,
      failure: eventText,
    })),
    failure: {
      stepIndex: 63,
      kind: "assertText",
      name: "StepError",
      message: errorText,
    },
    artifacts: {
      trace: "trace.zip",
      failureScreenshot: "failure.png",
      stepSnapshots: steps.map((step) => step.snapshot),
      screenshots: steps
        .map((step) => step.screenshot)
        .filter((value) => value !== null),
    },
  };

  const serialized = serializeResultJson(denseResult);
  assert(Buffer.byteLength(serialized, "utf8") <= 1024 * 1024);
  assert.throws(
    () => serializeResultJson({ payload: "x".repeat(1024 * 1024) }),
    /serialized limit/,
  );
});

test(
  "runs a closed local journey and persists bounded semantic evidence",
  { skip: !HAS_BROWSER },
  async (t) => {
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html>
          <body>
            <main>
              <h1>Fixture ready</h1>
              <label>Name <input name="name"></label>
              <label>Theme
                <select aria-label="Theme">
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
              <label><input type="checkbox" aria-label="Enabled"> Enabled</label>
              <button type="button">Save</button>
              <p data-testid="status"></p>
            </main>
            <script>
              console.warn("synthetic warning password=console-secret");
              setTimeout(() => {
                throw new Error("token=page-error-secret");
              }, 0);
              document.querySelector("button").addEventListener("click", () => {
                const name = document.querySelector("[name=name]").value;
                const theme = document.querySelector("select").value;
                const enabled = document.querySelector("[aria-label=Enabled]").checked;
                document.querySelector("[data-testid=status]").textContent =
                  name + " · " + theme + " · " + enabled;
              });
            </script>
          </body>
        </html>`);
    });
    t.after(() => closeServer(fixture.server));

    const paths = await makeRunDirectory(t);
    const plan = basePlan(fixture.origin);
    plan.steps = [
      { kind: "navigate", path: "/" },
      {
        kind: "assertVisible",
        target: target("role", ["heading", "Fixture ready"]),
      },
      { kind: "fill", target: target("label", "Name"), value: "Ada" },
      { kind: "press", target: target("label", "Name"), key: "End" },
      { kind: "select", target: target("label", "Theme"), value: "dark" },
      { kind: "check", target: target("label", "Enabled") },
      { kind: "click", target: target("role", ["button", "Save"]) },
      {
        kind: "assertText",
        target: target("testId", "status"),
        value: "Ada · dark · true",
        exact: true,
      },
      { kind: "assertUrl", path: "/" },
      { kind: "screenshot" },
    ];

    const execution = await invokeDriver(paths, plan);
    const result = await readResult(paths);
    assert.equal(execution.code, 0, JSON.stringify(result, null, 2));
    assert.deepEqual(Object.keys(result), [
      "schemaVersion",
      "status",
      "times",
      "duration",
      "steps",
      "consoleErrors",
      "requests",
      "failure",
      "artifacts",
    ]);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.status, "passed");
    assert.equal(result.failure, null);
    assert.equal(result.steps.length, plan.steps.length);
    assert(result.steps.every((step) => step.status === "passed"));
    assert.equal(result.artifacts.trace, null);
    assert.equal(result.artifacts.failureScreenshot, null);
    assert.equal(result.artifacts.stepSnapshots.length, plan.steps.length);
    assert.equal(result.artifacts.screenshots.length, 1);
    assert(
      result.consoleErrors.some(
        (entry) =>
          entry.type === "warning" &&
          entry.text === "synthetic warning password=[REDACTED]",
      ),
    );
    assert(
      result.consoleErrors.some(
        (entry) => entry.type === "error" && entry.text === "token=[REDACTED]",
      ),
    );
    assert(!JSON.stringify(result).includes("console-secret"));
    assert(!JSON.stringify(result).includes("page-error-secret"));
    assert(
      result.requests.some(
        (entry) => entry.method === "GET" && entry.url === `${fixture.origin}/`,
      ),
    );

    for (const artifact of [
      ...result.artifacts.stepSnapshots,
      ...result.artifacts.screenshots,
    ]) {
      assert.equal(path.isAbsolute(artifact), false);
      assert.equal(artifact.split("/").includes(".."), false);
      await access(path.join(paths.artifactsPath, artifact));
    }
    const leftovers = (await import("node:fs/promises")).readdir(
      paths.runDirectory,
    );
    assert(
      !(await leftovers).some((name) => name.startsWith(".result.json.")),
      "atomic output temporary file was left behind",
    );
  },
);

test(
  "a failed assertion emits only failure artifacts and exits one",
  { skip: !HAS_BROWSER },
  async (t) => {
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<main><h1>Actual value</h1></main>");
    });
    t.after(() => closeServer(fixture.server));

    const paths = await makeRunDirectory(t);
    const plan = basePlan(fixture.origin);
    plan.timeoutMs = 3_000;
    plan.steps = [
      { kind: "navigate", path: "/" },
      {
        kind: "assertText",
        target: target("role", ["heading", "Actual value"]),
        value: "Different value",
        exact: true,
      },
      { kind: "screenshot" },
    ];

    const execution = await invokeDriver(paths, plan);
    assert.equal(execution.code, 1, execution.stderr);
    const result = await readResult(paths);
    assert.equal(result.status, "failed");
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[1].status, "failed");
    assert.equal(result.failure.stepIndex, 1);
    assert.equal(result.failure.kind, "assertText");
    assert.equal(typeof result.artifacts.trace, "string");
    assert.equal(typeof result.artifacts.failureScreenshot, "string");
    assert.deepEqual(result.artifacts.screenshots, []);
    await access(path.join(paths.artifactsPath, result.artifacts.trace));
    await access(path.join(paths.artifactsPath, result.artifacts.failureScreenshot));
  },
);

test(
  "aborts requests outside the exact origin allowlist without reaching the server",
  { skip: !HAS_BROWSER },
  async (t) => {
    let blockedServerHits = 0;
    const blocked = await listen((_request, response) => {
      blockedServerHits += 1;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("should not be reached");
    });
    t.after(() => closeServer(blocked.server));

    const fixture = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <p data-testid="status">waiting</p>
        <script>
          fetch(${JSON.stringify(`${blocked.origin}/secret?token=private`)})
            .then(() => {
              document.querySelector("[data-testid=status]").textContent = "unexpected";
            })
            .catch(() => {
              document.querySelector("[data-testid=status]").textContent = "blocked";
            });
        </script>`);
    });
    t.after(() => closeServer(fixture.server));

    const paths = await makeRunDirectory(t);
    const plan = basePlan(fixture.origin);
    plan.steps = [
      { kind: "navigate", path: "/" },
      {
        kind: "assertText",
        target: target("testId", "status"),
        value: "blocked",
        exact: true,
      },
    ];

    const execution = await invokeDriver(paths, plan);
    assert.equal(execution.code, 0, execution.stderr);
    const result = await readResult(paths);
    assert.equal(result.status, "passed");
    assert.equal(blockedServerHits, 0);
    const blockedRequest = result.requests.find(
      (entry) => entry.url === `${blocked.origin}/secret?[redacted]`,
    );
    assert(blockedRequest, JSON.stringify(result.requests, null, 2));
    assert.equal(blockedRequest.status, null);
    assert.match(blockedRequest.failure, /blocked by WTS origin policy|ERR_BLOCKED_BY_CLIENT/);
    assert(!JSON.stringify(result).includes("token=private"));
  },
);
