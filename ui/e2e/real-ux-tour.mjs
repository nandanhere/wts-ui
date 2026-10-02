// Read-only UX tour against a running WTS server that holds real workspaces.
// Usage: WTS_REAL_URL=http://127.0.0.1:18990 WTS_TOUR_DIR=/tmp/wtstour/real node e2e/real-ux-tour.mjs
// The tour only opens views. It does not create, change, run, or post anything.
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const origin = process.env.WTS_REAL_URL ?? "http://127.0.0.1:18990";
const dir = resolve(process.env.WTS_TOUR_DIR ?? "test-results/real-tour");
const maxWorkspaces = Number(process.env.WTS_TOUR_WORKSPACES ?? 3);
await mkdir(dir, { recursive: true });
const notes = [];
let n = 0;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (error) => notes.push({ file: null, step: "Page error: " + error.message }));
async function shot(step) {
  n += 1;
  const file = String(n).padStart(2, "0") + ".png";
  await page.waitForTimeout(1200);
  await page.screenshot({ path: resolve(dir, file) });
  notes.push({ file, step });
  console.log(file, step);
}
async function tab(name) {
  const t = page.getByRole("tab", { name }).first();
  if (!(await t.count())) return false;
  await t.click().catch(() => undefined);
  await page.waitForTimeout(1500);
  return true;
}
async function home() {
  const spaces = page.getByRole("button", { name: "Open Spaces", exact: true });
  if (await spaces.count()) await spaces.click().catch(() => undefined);
  else await page.goto(origin);
  await page.waitForTimeout(1000);
}
const cardPattern = /^Open .* details$/;

await page.goto(origin);
await page.waitForSelector('[data-ui="spaces.lanes"]', { timeout: 30000 }).catch(() => undefined);
await page.waitForTimeout(3000);
await shot("Start screen: the real Spaces board on this laptop.");
// WTS_TOUR_MATCH is an optional comma list of workspace names. It keeps rounds comparable when live agents reorder the board.
const wanted = (process.env.WTS_TOUR_MATCH ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const allLabels = await page.getByRole("button", { name: cardPattern }).evaluateAll((cards) => cards.map((card) => card.getAttribute("aria-label") ?? ""));
const picks = wanted.length
  ? wanted.map((name) => allLabels.findIndex((label) => label.includes(name))).filter((index) => index >= 0)
  : allLabels.map((_, index) => index);
const count = Math.min(picks.length, maxWorkspaces);
for (let i = 0; i < count; i += 1) {
  await home();
  const card = page.getByRole("button", { name: cardPattern }).nth(picks[i]);
  const label = ((await card.getAttribute("aria-label")) ?? "workspace").replace(/^Open | details$/g, "");
  await card.click().catch(() => undefined);
  await page.waitForTimeout(2500);
  await shot("Opened real workspace " + label + ": overview tab.");
  if (await tab(/^(Plans|Agent review)/)) await shot(label + ": Plans tab.");
  if (await tab(/^(Changes|Code review)/)) {
    // Real comparisons read GitLab and can take several seconds. Wait until the loading state ends.
    await page.locator('[data-ui="changes.comparison-loading"]').waitFor({ state: "detached", timeout: 20000 }).catch(() => undefined);
    await page.waitForTimeout(1000);
    await shot(label + ": Changes tab with real diffs.");
    const conv = page.locator('[data-ui="repository-review.views"]').getByRole("tab", { name: /^Conversations/ });
    if (await conv.count()) { await conv.click().catch(() => undefined); await shot(label + ": Conversations."); }
  }
  if (await tab(/^Verify$/)) await shot(label + ": Verify tab.");
}
await home();
await page.setViewportSize({ width: 1024, height: 768 });
await shot("Spaces board at a 1024x768 laptop size.");
await writeFile(resolve(dir, "notes.json"), JSON.stringify(notes, null, 2));
await browser.close();
