import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(new URL("../ui/package.json", import.meta.url));
const { chromium, expect } = require("@playwright/test");
const [origin, candidateUi] = process.argv.slice(2);
const url = new URL(origin);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.protocol, "http:");
assert.equal(await readFile(join(candidateUi, ".browser-fixture"), "utf8"), "wts-candidate-preview-test\n");

const browser = await chromium.launch();
const context = await browser.newContext();
const errors = [];
const navigations = [];
try {
  await context.route("**/*", route => new URL(route.request().url()).origin === url.origin
    ? route.continue() : route.abort("blockedbyclient"));
  const page = await context.newPage();
  let hmrConnected = false;
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  page.on("websocket", socket => socket.on("framereceived", ({ payload }) => {
    if (String(payload) === '{"type":"connected"}') hmrConnected = true;
  }));
  const dependency = page.waitForResponse(response => response.url().includes("preview-fixture-dependency"));
  await page.goto(origin);
  await expect(page.locator("#candidate-result")).toHaveText("DEPENDENCY_VALUE: BEFORE_UPDATE");
  assert.equal((await dependency).status(), 200);
  const documentId = await page.evaluate(() => window.previewDocumentId);
  assert.equal(typeof documentId, "string");
  await expect.poll(() => hmrConnected, { message: "The candidate must establish its live update connection.", timeout: 10_000 }).toBe(true);

  await writeFile(join(candidateUi, "value.js"), "export default 'AFTER_UPDATE';\n");
  await expect(page.locator("#candidate-result")).toHaveText("DEPENDENCY_VALUE: AFTER_UPDATE");
  assert.equal(await page.evaluate(() => window.previewDocumentId), documentId, "The HMR update must retain the same document.");
  assert.equal(navigations.length, 1, "The update must not reload or navigate the page.");
  assert.deepEqual(errors, []);
  console.log("Candidate browser passed: imported dependency rendered; edited module updated the DOM without a page reload.");
} finally {
  await context.close();
  await browser.close();
}
