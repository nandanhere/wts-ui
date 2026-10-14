#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const LIMITS = Object.freeze({
  resultBytes: 1024 * 1024,
  planBytes: 256 * 1024,
  idBytes: 128,
  titleBytes: 256,
  originBytes: 512,
  pathBytes: 2_048,
  targetBytes: 512,
  valueBytes: 4_096,
  steps: 64,
  screenshotSteps: 16,
  origins: 8,
  timeoutMinMs: 1_000,
  timeoutMaxMs: 300_000,
  actionTimeoutMaxMs: 15_000,
  consoleEvents: 64,
  requestEvents: 96,
  eventTextBytes: 1_024,
  snapshotBytes: 64 * 1024,
  errorBytes: 1_536,
});

const PLAN_KEYS = [
  "schemaVersion",
  "runId",
  "workspaceId",
  "journeyId",
  "title",
  "baseUrl",
  "allowedOrigins",
  "timeoutMs",
  "steps",
];

const TARGET_KEYS = Object.freeze({
  role: ["kind", "role", "name", "exact"],
  label: ["kind", "value", "exact"],
  text: ["kind", "value", "exact"],
  testId: ["kind", "value"],
});

const STEP_KEYS = Object.freeze({
  navigate: ["kind", "path"],
  click: ["kind", "target"],
  fill: ["kind", "target", "value"],
  select: ["kind", "target", "value"],
  check: ["kind", "target"],
  press: ["kind", "target", "key"],
  assertVisible: ["kind", "target"],
  assertText: ["kind", "target", "value", "exact"],
  assertUrl: ["kind", "path"],
  screenshot: ["kind"],
});

const ALLOWED_KEYS = new Set([
  "Enter",
  "Escape",
  "Tab",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
]);

const ARIA_ROLES = new Set([
  "alert",
  "alertdialog",
  "application",
  "article",
  "banner",
  "blockquote",
  "button",
  "caption",
  "cell",
  "checkbox",
  "code",
  "columnheader",
  "combobox",
  "complementary",
  "contentinfo",
  "definition",
  "deletion",
  "dialog",
  "directory",
  "document",
  "emphasis",
  "feed",
  "figure",
  "form",
  "generic",
  "grid",
  "gridcell",
  "group",
  "heading",
  "img",
  "insertion",
  "link",
  "list",
  "listbox",
  "listitem",
  "log",
  "main",
  "marquee",
  "math",
  "meter",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "navigation",
  "none",
  "note",
  "option",
  "paragraph",
  "presentation",
  "progressbar",
  "radio",
  "radiogroup",
  "region",
  "row",
  "rowgroup",
  "rowheader",
  "scrollbar",
  "search",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "status",
  "strong",
  "subscript",
  "superscript",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "term",
  "textbox",
  "time",
  "timer",
  "toolbar",
  "tooltip",
  "tree",
  "treegrid",
  "treeitem",
]);

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function assertExactKeys(value, expectedKeys, label) {
  if (!isRecord(value)) {
    throw new InputError(`${label} must be an object`);
  }

  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new InputError(
      `${label} must contain exactly: ${expectedKeys.join(", ")}`,
    );
  }
}

function assertBoundedString(value, label, maxBytes, { allowEmpty = false } = {}) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    byteLength(value) > maxBytes ||
    value.includes("\0")
  ) {
    throw new InputError(
      `${label} must be ${allowEmpty ? "a" : "a non-empty"} string of at most ${maxBytes} UTF-8 bytes`,
    );
  }
}

function validateId(value, label) {
  assertBoundedString(value, label, LIMITS.idBytes);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new InputError(
      `${label} may contain only ASCII letters, numbers, period, underscore, and hyphen`,
    );
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") {
    return true;
  }
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    Number(parts[0]) === 127
  );
}

function validateOrigin(value, label) {
  assertBoundedString(value, label, LIMITS.originBytes);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new InputError(`${label} must be a valid URL origin`);
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !isLoopbackHostname(parsed.hostname) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    value !== parsed.origin
  ) {
    throw new InputError(
      `${label} must be a canonical loopback http(s) origin without credentials or a path`,
    );
  }
  return parsed.origin;
}

function validateRelativePath(value, label, baseUrl) {
  assertBoundedString(value, label, LIMITS.pathBytes);
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    throw new InputError(`${label} must be an origin-relative path beginning with one slash`);
  }

  let parsed;
  try {
    parsed = new URL(value, baseUrl);
  } catch {
    throw new InputError(`${label} must be a valid origin-relative URL`);
  }
  if (parsed.origin !== baseUrl) {
    throw new InputError(`${label} must stay within the plan baseUrl origin`);
  }
  return value;
}

function validateTarget(target, label) {
  if (!isRecord(target) || typeof target.kind !== "string") {
    throw new InputError(`${label} must be a target object`);
  }
  const expectedKeys = TARGET_KEYS[target.kind];
  if (!expectedKeys) {
    throw new InputError(`${label}.kind is not supported`);
  }
  assertExactKeys(target, expectedKeys, label);

  if (target.kind === "role") {
    if (!ARIA_ROLES.has(target.role)) {
      throw new InputError(`${label}.role is not a supported ARIA role`);
    }
    assertBoundedString(target.name, `${label}.name`, LIMITS.targetBytes);
    if (typeof target.exact !== "boolean") {
      throw new InputError(`${label}.exact must be a boolean`);
    }
  } else {
    assertBoundedString(target.value, `${label}.value`, LIMITS.targetBytes);
    if (target.kind !== "testId" && typeof target.exact !== "boolean") {
      throw new InputError(`${label}.exact must be a boolean`);
    }
  }
}

function validateStep(step, index, baseUrl) {
  const label = `steps[${index}]`;
  if (!isRecord(step) || typeof step.kind !== "string") {
    throw new InputError(`${label} must be a step object`);
  }
  const expectedKeys = STEP_KEYS[step.kind];
  if (!expectedKeys) {
    throw new InputError(`${label}.kind is not supported`);
  }
  assertExactKeys(step, expectedKeys, label);

  if ("target" in step) {
    validateTarget(step.target, `${label}.target`);
  }
  if (step.kind === "navigate" || step.kind === "assertUrl") {
    validateRelativePath(step.path, `${label}.path`, baseUrl);
  }
  if (step.kind === "fill" || step.kind === "select" || step.kind === "assertText") {
    assertBoundedString(step.value, `${label}.value`, LIMITS.valueBytes, {
      allowEmpty: step.kind === "fill",
    });
  }
  if (step.kind === "assertText" && typeof step.exact !== "boolean") {
    throw new InputError(`${label}.exact must be a boolean`);
  }
  if (step.kind === "press" && !ALLOWED_KEYS.has(step.key)) {
    throw new InputError(`${label}.key is not allowlisted`);
  }
}

export function validatePlan(value) {
  assertExactKeys(value, PLAN_KEYS, "plan");
  if (value.schemaVersion !== 1) {
    throw new InputError("plan.schemaVersion must be 1");
  }
  validateId(value.runId, "plan.runId");
  validateId(value.workspaceId, "plan.workspaceId");
  validateId(value.journeyId, "plan.journeyId");
  assertBoundedString(value.title, "plan.title", LIMITS.titleBytes);

  const baseUrl = validateOrigin(value.baseUrl, "plan.baseUrl");
  if (
    !Array.isArray(value.allowedOrigins) ||
    value.allowedOrigins.length === 0 ||
    value.allowedOrigins.length > LIMITS.origins
  ) {
    throw new InputError(
      `plan.allowedOrigins must contain between 1 and ${LIMITS.origins} origins`,
    );
  }
  const seenOrigins = new Set();
  for (const [index, origin] of value.allowedOrigins.entries()) {
    const normalized = validateOrigin(origin, `plan.allowedOrigins[${index}]`);
    if (seenOrigins.has(normalized)) {
      throw new InputError("plan.allowedOrigins must not contain duplicates");
    }
    seenOrigins.add(normalized);
  }
  if (!seenOrigins.has(baseUrl)) {
    throw new InputError("plan.allowedOrigins must contain plan.baseUrl exactly");
  }

  if (
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < LIMITS.timeoutMinMs ||
    value.timeoutMs > LIMITS.timeoutMaxMs
  ) {
    throw new InputError(
      `plan.timeoutMs must be an integer from ${LIMITS.timeoutMinMs} to ${LIMITS.timeoutMaxMs}`,
    );
  }
  if (
    !Array.isArray(value.steps) ||
    value.steps.length === 0 ||
    value.steps.length > LIMITS.steps
  ) {
    throw new InputError(`plan.steps must contain between 1 and ${LIMITS.steps} steps`);
  }

  let screenshotSteps = 0;
  value.steps.forEach((step, index) => {
    validateStep(step, index, baseUrl);
    if (step.kind === "screenshot") {
      screenshotSteps += 1;
    }
  });
  if (screenshotSteps > LIMITS.screenshotSteps) {
    throw new InputError(
      `plan.steps may contain at most ${LIMITS.screenshotSteps} screenshot steps`,
    );
  }

  return {
    ...value,
    allowedOrigins: [...value.allowedOrigins],
    steps: value.steps.map((step) => structuredClone(step)),
  };
}

function parseCli(argv) {
  if (argv.length !== 6) {
    throw new InputError(
      "usage: node scripts/wts-browser-driver.mjs --plan <canonical-json> --artifacts <canonical-dir> --output <canonical-json>",
    );
  }
  const allowed = new Set(["--plan", "--artifacts", "--output"]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || flag in result || typeof value !== "string" || value === "") {
      throw new InputError("CLI flags must be unique --plan, --artifacts, and --output pairs");
    }
    result[flag] = value;
  }
  if (Object.keys(result).length !== 3) {
    throw new InputError("CLI requires --plan, --artifacts, and --output");
  }
  return {
    planPath: result["--plan"],
    artifactsPath: result["--artifacts"],
    outputPath: result["--output"],
  };
}

async function requireCanonicalExistingPath(inputPath, label, type) {
  if (!isAbsolute(inputPath) || resolve(inputPath) !== inputPath) {
    throw new InputError(`${label} must be an absolute normalized path`);
  }
  let canonical;
  try {
    canonical = await realpath(inputPath);
  } catch {
    throw new InputError(`${label} does not exist`);
  }
  if (canonical !== inputPath) {
    throw new InputError(`${label} must be canonical and must not traverse a symlink`);
  }
  const info = await stat(canonical);
  if ((type === "file" && !info.isFile()) || (type === "directory" && !info.isDirectory())) {
    throw new InputError(`${label} must be a ${type}`);
  }
  return canonical;
}

async function requireCanonicalOutputPath(inputPath) {
  if (!isAbsolute(inputPath) || resolve(inputPath) !== inputPath) {
    throw new InputError("--output must be an absolute normalized path");
  }
  if (basename(inputPath) === "" || !basename(inputPath).endsWith(".json")) {
    throw new InputError("--output must name a JSON file");
  }
  const canonicalParent = await requireCanonicalExistingPath(
    dirname(inputPath),
    "--output parent",
    "directory",
  );
  const canonicalCandidate = join(canonicalParent, basename(inputPath));
  if (canonicalCandidate !== inputPath) {
    throw new InputError("--output must be canonical");
  }
  let outputInfo;
  try {
    outputInfo = await lstat(inputPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new InputError(
        "--output must be an existing canonical zero-byte regular file reserved by WTS",
      );
    }
    throw error;
  }
  if (!outputInfo.isFile() || outputInfo.isSymbolicLink() || outputInfo.size !== 0) {
    throw new InputError(
      "--output must be an existing canonical zero-byte regular file reserved by WTS",
    );
  }
  const canonicalOutput = await realpath(inputPath);
  if (canonicalOutput !== inputPath) {
    throw new InputError("--output must be canonical and must not traverse a symlink");
  }
  return inputPath;
}

async function readPlan(planPath) {
  const info = await stat(planPath);
  if (info.size > LIMITS.planBytes) {
    throw new InputError(`plan JSON must not exceed ${LIMITS.planBytes} bytes`);
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(planPath, "utf8"));
  } catch (error) {
    throw new InputError(`plan is not valid JSON: ${boundedErrorMessage(error)}`);
  }
  return validatePlan(parsed);
}

function truncateUtf8(value, maxBytes) {
  const text = String(value);
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) {
    return text;
  }
  const suffix = "\n…[truncated]";
  const suffixBuffer = Buffer.from(suffix, "utf8");
  const prefixBudget =
    maxBytes >= suffixBuffer.length ? maxBytes - suffixBuffer.length : maxBytes;
  const codePoints = [];
  let usedBytes = 0;
  for (const codePoint of text) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (usedBytes + codePointBytes > prefixBudget) {
      break;
    }
    codePoints.push(codePoint);
    usedBytes += codePointBytes;
  }
  const prefix = codePoints.join("");
  return maxBytes >= suffixBuffer.length ? `${prefix}${suffix}` : prefix;
}

export function redactEvidenceText(value, maxBytes = LIMITS.eventTextBytes) {
  let text = String(value).replace(
    // Strip terminal control sequences before evidence reaches another process.
    /\u001b\[[0-?]*[ -/]*[@-~]/g,
    "",
  );
  text = text.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
    "$1 [REDACTED]",
  );
  text = text.replace(
    /\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]*/gi,
    "$1: [REDACTED]",
  );
  text = text.replace(
    /((?:["']?(?:api[-_ ]?key|access[-_ ]?key|client[-_ ]?secret|token|password|passwd|pwd|secret)["']?)\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;&]+)/gi,
    "$1[REDACTED]",
  );
  return truncateUtf8(text, maxBytes);
}

function sensitivePathSegment(segment) {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Preserve the encoded form for conservative pattern checks.
  }
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      decoded,
    ) ||
    /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(
      decoded,
    ) ||
    /^(?:sk|pk|api|key|token|secret|gh[pousr]|github_pat|xox[baprs])[-_][A-Za-z0-9+/_=.~-]{8,}$/i.test(
      decoded,
    ) ||
    /^AKIA[0-9A-Z]{16}$/.test(decoded)
  ) {
    return true;
  }
  if (
    decoded.length >= 32 &&
    /^[A-Za-z0-9+/_=-]+$/.test(decoded)
  ) {
    const classes = [
      /[a-z]/.test(decoded),
      /[A-Z]/.test(decoded),
      /[0-9]/.test(decoded),
    ].filter(Boolean).length;
    const uniqueCharacters = new Set(decoded.toLowerCase()).size;
    return (
      classes >= 2 ||
      (!decoded.includes("-") &&
        !decoded.includes("_") &&
        uniqueCharacters >= 12)
    );
  }
  return false;
}

export function redactRequestUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return truncateUtf8(`${parsed.protocol}[redacted]`, LIMITS.pathBytes);
    }
    parsed.username = "";
    parsed.password = "";
    const hadQuery = parsed.search !== "";
    const pathname = parsed.pathname
      .split("/")
      .map((segment) =>
        segment && sensitivePathSegment(segment) ? "[redacted]" : segment,
      )
      .join("/");
    return truncateUtf8(
      `${parsed.origin}${pathname}${hadQuery ? "?[redacted]" : ""}`,
      LIMITS.pathBytes,
    );
  } catch {
    return "[invalid-url]";
  }
}

function boundedErrorMessage(error) {
  if (error instanceof Error) {
    return redactEvidenceText(error.message || error.name, LIMITS.errorBytes);
  }
  return redactEvidenceText(String(error), LIMITS.errorBytes);
}

function safeArtifactPath(artifactsPath, absolutePath) {
  const result = relative(artifactsPath, absolutePath);
  if (
    result === "" ||
    isAbsolute(result) ||
    result === ".." ||
    result.startsWith(`..${sep}`)
  ) {
    throw new Error("generated artifact path escaped the artifact directory");
  }
  return result.split(sep).join("/");
}

export function serializeResultJson(value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  if (payloadBytes > LIMITS.resultBytes) {
    throw new Error(
      `browser result exceeds the ${LIMITS.resultBytes}-byte serialized limit`,
    );
  }
  return payload;
}

async function atomicWriteJson(outputPath, value) {
  const suffix = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const temporaryPath = join(dirname(outputPath), `.${basename(outputPath)}.${suffix}.tmp`);
  const payload = serializeResultJson(value);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, outputPath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function locatorFor(page, target) {
  switch (target.kind) {
    case "role":
      return page.getByRole(target.role, { name: target.name, exact: target.exact });
    case "label":
      return page.getByLabel(target.value, { exact: target.exact });
    case "text":
      return page.getByText(target.value, { exact: target.exact });
    case "testId":
      return page.getByTestId(target.value);
    default:
      throw new Error("unreachable target kind");
  }
}

function stepTimeout(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("journey exceeded its timeout");
  }
  return Math.max(1, Math.min(remaining, LIMITS.actionTimeoutMaxMs));
}

async function waitForText(locator, value, exact, timeout) {
  const deadline = Date.now() + timeout;
  let lastText = null;
  while (Date.now() <= deadline) {
    await locator.waitFor({ state: "visible", timeout: Math.max(1, deadline - Date.now()) });
    lastText = await locator.textContent({ timeout: Math.max(1, deadline - Date.now()) });
    const matched = exact ? lastText === value : (lastText ?? "").includes(value);
    if (matched) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const comparison = exact ? "equal" : "contain";
  throw new Error(
    `expected target text to ${comparison} ${JSON.stringify(value)}, received ${JSON.stringify(lastText)}`,
  );
}

async function executeStep(page, step, baseUrl, deadline, screenshotPath) {
  const timeout = stepTimeout(deadline);
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);

  switch (step.kind) {
    case "navigate":
      await page.goto(new URL(step.path, baseUrl).href, {
        waitUntil: "domcontentloaded",
        timeout,
      });
      break;
    case "click":
      await locatorFor(page, step.target).click({ timeout });
      break;
    case "fill":
      await locatorFor(page, step.target).fill(step.value, { timeout });
      break;
    case "select":
      await locatorFor(page, step.target).selectOption(step.value, { timeout });
      break;
    case "check":
      await locatorFor(page, step.target).check({ timeout });
      break;
    case "press":
      await locatorFor(page, step.target).press(step.key, { timeout });
      break;
    case "assertVisible":
      await locatorFor(page, step.target).waitFor({ state: "visible", timeout });
      break;
    case "assertText":
      await waitForText(locatorFor(page, step.target), step.value, step.exact, timeout);
      break;
    case "assertUrl":
      await page.waitForURL(new URL(step.path, baseUrl).href, {
        waitUntil: "commit",
        timeout,
      });
      break;
    case "screenshot":
      await page.screenshot({
        path: screenshotPath,
        fullPage: false,
        animations: "disabled",
        timeout,
      });
      break;
    default:
      throw new Error("unreachable step kind");
  }
}

function httpOriginForWebSocket(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  } else {
    return null;
  }
  return parsed.origin;
}

function pushBounded(items, value, limit) {
  if (items.length === limit) {
    items.shift();
  }
  items.push(value);
}

async function makeNetworkRecorder(context, allowedOrigins) {
  const requests = [];
  const byRequest = new WeakMap();

  const getOrCreate = (request) => {
    const existing = byRequest.get(request);
    if (existing) {
      return existing;
    }
    const entry = {
      method: truncateUtf8(request.method(), 32),
      url: redactRequestUrl(request.url()),
      status: null,
      failure: null,
    };
    pushBounded(requests, entry, LIMITS.requestEvents);
    byRequest.set(request, entry);
    return entry;
  };

  context.on("request", (request) => {
    getOrCreate(request);
  });
  context.on("response", (response) => {
    const entry = getOrCreate(response.request());
    if (entry) {
      entry.status = response.status();
    }
  });
  context.on("requestfailed", (request) => {
    const entry = getOrCreate(request);
    if (entry && entry.failure === null) {
      entry.failure = redactEvidenceText(
        request.failure()?.errorText ?? "request failed",
        LIMITS.eventTextBytes,
      );
    }
  });

  await context.route("**/*", async (route) => {
    const request = route.request();
    const entry = getOrCreate(request);
    let allowed = false;
    try {
      const parsed = new URL(request.url());
      allowed =
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        allowedOrigins.has(parsed.origin);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      if (entry) {
        entry.failure = "blocked by WTS origin policy";
      }
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  await context.routeWebSocket(/.*/, async (webSocket) => {
    const url = redactRequestUrl(webSocket.url());
    const origin = httpOriginForWebSocket(webSocket.url());
    if (!origin || !allowedOrigins.has(origin)) {
      pushBounded(
        requests,
        {
          method: "WEBSOCKET",
          url,
          status: null,
          failure: "blocked by WTS origin policy",
        },
        LIMITS.requestEvents,
      );
      await webSocket.close({ code: 1008, reason: "WTS origin policy" });
      return;
    }
    pushBounded(
      requests,
      { method: "WEBSOCKET", url, status: 101, failure: null },
      LIMITS.requestEvents,
    );
    webSocket.connectToServer();
  });

  return requests;
}

function attachConsoleRecorder(context) {
  const consoleErrors = [];
  const attachedPages = new WeakSet();
  const attach = (page) => {
    if (attachedPages.has(page)) {
      return;
    }
    attachedPages.add(page);
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        pushBounded(
          consoleErrors,
          {
            type: message.type(),
            text: redactEvidenceText(message.text(), LIMITS.eventTextBytes),
            timestampUnixMs: Date.now(),
          },
          LIMITS.consoleEvents,
        );
      }
    });
    page.on("pageerror", (error) => {
      pushBounded(
        consoleErrors,
        {
          type: "error",
          text: boundedErrorMessage(error),
          timestampUnixMs: Date.now(),
        },
        LIMITS.consoleEvents,
      );
    });
    page.on("download", (download) => {
      void download.cancel().catch(() => {});
    });
  };
  context.on("page", attach);
  return { consoleErrors, attach };
}

async function captureAriaSnapshot(page, artifactsPath, index, kind) {
  const snapshotsDirectory = join(artifactsPath, "aria");
  const snapshotPath = join(
    snapshotsDirectory,
    `${String(index + 1).padStart(3, "0")}-${kind}.aria.yml`,
  );
  const snapshot = await page.locator("body").ariaSnapshot({
    depth: 16,
    mode: "default",
    timeout: 1_000,
  });
  await writeFile(
    snapshotPath,
    `${redactEvidenceText(snapshot, LIMITS.snapshotBytes)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return safeArtifactPath(artifactsPath, snapshotPath);
}

async function captureFailureScreenshot(page, artifactsPath) {
  const screenshotPath = join(artifactsPath, "failure.png");
  await access(screenshotPath, fsConstants.F_OK).then(
    () => {
      throw new Error("failure screenshot path already exists");
    },
    () => {},
  );
  await page.screenshot({
    path: screenshotPath,
    fullPage: false,
    animations: "disabled",
    timeout: 5_000,
  });
  return safeArtifactPath(artifactsPath, screenshotPath);
}

export async function executeJourney(plan, artifactsPath) {
  const startedAtUnixMs = Date.now();
  const deadline = startedAtUnixMs + plan.timeoutMs;
  const stepResults = [];
  const stepSnapshots = [];
  const screenshots = [];
  let browser;
  let context;
  let page;
  let consoleErrors = [];
  let requests = [];
  let failure = null;
  let trace = null;
  let failureScreenshot = null;
  let tracingStarted = false;

  try {
    for (const reservedPath of [
      join(artifactsPath, "aria"),
      join(artifactsPath, "screenshots"),
      join(artifactsPath, "failure.png"),
      join(artifactsPath, "trace.zip"),
    ]) {
      try {
        await lstat(reservedPath);
        throw new Error(`reserved artifact path already exists: ${basename(reservedPath)}`);
      } catch (pathError) {
        if (pathError?.code !== "ENOENT") {
          throw pathError;
        }
      }
    }
    await mkdir(join(artifactsPath, "aria"), { mode: 0o700 });
    if (plan.steps.some((step) => step.kind === "screenshot")) {
      await mkdir(join(artifactsPath, "screenshots"), { mode: 0o700 });
    }

    browser = await chromium.launch({
      headless: true,
      timeout: stepTimeout(deadline),
    });
    context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      viewport: { width: 1280, height: 720 },
    });
    requests = await makeNetworkRecorder(context, new Set(plan.allowedOrigins));
    const consoleRecorder = attachConsoleRecorder(context);
    consoleErrors = consoleRecorder.consoleErrors;
    page = await context.newPage();
    consoleRecorder.attach(page);

    await context.tracing.start({
      screenshots: true,
      // ARIA snapshots are captured separately. Disabling Playwright's
      // DOM/network snapshots keeps headers and bodies out of the trace.
      snapshots: false,
      sources: false,
      title: truncateUtf8(plan.title, LIMITS.titleBytes),
    });
    tracingStarted = true;

    for (const [index, step] of plan.steps.entries()) {
      const stepStartedAtUnixMs = Date.now();
      let error = null;
      let snapshot = null;
      let screenshot = null;
      const screenshotPath =
        step.kind === "screenshot"
          ? join(
              artifactsPath,
              "screenshots",
              `${String(index + 1).padStart(3, "0")}.png`,
            )
          : null;
      try {
        if (screenshotPath) {
          try {
            await lstat(screenshotPath);
            throw new Error("step screenshot path already exists");
          } catch (pathError) {
            if (pathError?.code !== "ENOENT") {
              throw pathError;
            }
          }
        }
        await executeStep(page, step, plan.baseUrl, deadline, screenshotPath);
        if (screenshotPath) {
          screenshot = safeArtifactPath(artifactsPath, screenshotPath);
          screenshots.push(screenshot);
        }
      } catch (stepError) {
        error = boundedErrorMessage(stepError);
      }

      try {
        snapshot = await captureAriaSnapshot(
          page,
          artifactsPath,
          index,
          step.kind,
        );
        stepSnapshots.push(snapshot);
      } catch {
        snapshot = null;
      }

      const stepCompletedAtUnixMs = Date.now();
      stepResults.push({
        index,
        kind: step.kind,
        status: error === null ? "passed" : "failed",
        startedAtUnixMs: stepStartedAtUnixMs,
        completedAtUnixMs: stepCompletedAtUnixMs,
        duration: Math.max(0, stepCompletedAtUnixMs - stepStartedAtUnixMs),
        snapshot,
        screenshot,
        error,
      });

      if (error !== null) {
        failure = {
          stepIndex: index,
          kind: step.kind,
          name: "StepError",
          message: error,
        };
        break;
      }
    }
  } catch (error) {
    failure = {
      stepIndex: null,
      kind: null,
      name: error instanceof Error ? truncateUtf8(error.name, 128) : "Error",
      message: boundedErrorMessage(error),
    };
  }

  if (failure !== null && page) {
    try {
      failureScreenshot = await captureFailureScreenshot(page, artifactsPath);
    } catch {
      failureScreenshot = null;
    }
  }

  if (context && tracingStarted) {
    try {
      if (failure !== null) {
        const tracePath = join(artifactsPath, "trace.zip");
        try {
          await lstat(tracePath);
          throw new Error("trace path already exists");
        } catch (pathError) {
          if (pathError?.code !== "ENOENT") {
            throw pathError;
          }
        }
        await context.tracing.stop({ path: tracePath });
        trace = safeArtifactPath(artifactsPath, tracePath);
      } else {
        await context.tracing.stop();
      }
    } catch {
      trace = null;
    }
  }

  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});

  const completedAtUnixMs = Date.now();
  return {
    schemaVersion: 1,
    status: failure === null ? "passed" : "failed",
    times: {
      startedAtUnixMs,
      completedAtUnixMs,
    },
    duration: Math.max(0, completedAtUnixMs - startedAtUnixMs),
    steps: stepResults,
    consoleErrors,
    requests,
    failure,
    artifacts: {
      trace,
      failureScreenshot,
      stepSnapshots,
      screenshots,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  let cli;
  try {
    cli = parseCli(argv);
    const planPath = await requireCanonicalExistingPath(cli.planPath, "--plan", "file");
    if (!basename(planPath).endsWith(".json")) {
      throw new InputError("--plan must name a JSON file");
    }
    const artifactsPath = await requireCanonicalExistingPath(
      cli.artifactsPath,
      "--artifacts",
      "directory",
    );
    const outputPath = await requireCanonicalOutputPath(cli.outputPath);
    if (planPath === outputPath) {
      throw new InputError("--plan and --output must be different paths");
    }
    const plan = await readPlan(planPath);
    const result = await executeJourney(plan, artifactsPath);
    await atomicWriteJson(outputPath, result);
    return result.status === "passed" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`wts-browser-driver: ${boundedErrorMessage(error)}\n`);
    return error instanceof InputError ? 2 : 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await main();
}
