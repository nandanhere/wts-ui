// Read-only My time tour against a running WTS server with real data.
// Usage: WTS_TOUR_DIR=/tmp/wtstime/r1 node e2e/real-my-time-tour.mjs
// It opens My time, builds today's review (a read of ActivityWatch), hovers a block, and captures both themes.
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const origin = process.env.WTS_REAL_URL ?? "http://127.0.0.1:18990";
const dir = resolve(process.env.WTS_TOUR_DIR ?? "test-results/my-time-tour");
await mkdir(dir, { recursive: true });
const notes = [];
let n = 0;
const browser = await chromium.launch();

async function tour(theme, viewport) {
  const context = await browser.newContext({ viewport, colorScheme: theme });
  const page = await context.newPage();
  page.on("pageerror", (error) => notes.push({ file: null, step: "Page error: " + error.message }));
  async function shot(step, fullPage = false) {
    n += 1;
    const file = String(n).padStart(2, "0") + ".png";
    await page.waitForTimeout(900);
    await page.screenshot({ path: resolve(dir, file), fullPage });
    notes.push({ file, step: `[${theme} ${viewport.width}x${viewport.height}] ${step}` });
    console.log(file, theme, step);
  }
  await page.addInitScript((mode) => {
    try { localStorage.setItem("wts.appearance.theme.v1", mode); } catch {}
  }, theme);
  await page.goto(origin);
  await page.waitForSelector('[data-ui="spaces.lanes"]', { timeout: 30000 }).catch(() => undefined);
  await page.getByRole("button", { name: /My time/ }).first().click();
  await page.waitForTimeout(2500);
  await shot("My time page as it opens.");
  const build = page.getByRole("button", { name: /Build today|Refresh review|^Refresh$/ }).first();
  if (await build.count()) {
    await build.click().catch(() => undefined);
    await page.waitForTimeout(400);
    await shot("Right after starting to build the review (loading state).");
    await page.waitForTimeout(6000);
  }
  await shot("My time with today's review built from real ActivityWatch and agent data.");
  const block = page.locator('[aria-label="Agent work timeline"] [role="img"], [aria-label="Daily activity timeline"] [role="img"]').first();
  if (await block.count()) {
    await block.hover().catch(() => undefined);
    await page.waitForTimeout(700);
    await shot("Hovering the first timeline block (tooltip).");
  }
  const expand = page.getByRole("button", { name: /^Show details for / }).first();
  if (await expand.count()) {
    await expand.click().catch(() => undefined);
    await expand.scrollIntoViewIfNeeded().catch(() => undefined);
    await shot("First activity block expanded (accordion).");
  }
  await shot("Full My time page (scrolled).", true);
  await context.close();
}

await tour("dark", { width: 1440, height: 900 });
await tour("light", { width: 1440, height: 900 });
await tour("dark", { width: 1024, height: 768 });
await writeFile(resolve(dir, "notes.json"), JSON.stringify(notes, null, 2));
await browser.close();

