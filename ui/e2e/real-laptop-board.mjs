// Read-only check against a running WTS server with real workspaces.
// At 1024x768 every lane header must be visible, or the jump bar must bring it into view.
// Usage: WTS_REAL_URL=http://127.0.0.1:18990 node e2e/real-laptop-board.mjs
import { chromium } from "@playwright/test";

const origin = process.env.WTS_REAL_URL ?? "http://127.0.0.1:18990";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
await page.goto(origin);
await page.waitForSelector('[data-ui="spaces.lanes"]', { timeout: 30000 });
const failures = [];
const jump = page.locator('[data-ui="spaces.lane-jump"]');
if (!(await jump.isVisible())) failures.push("The column jump bar is not visible at 1024x768.");
for (const lane of ["Ready", "Review", "Active", "Parked"]) {
  const header = page.getByRole("heading", { level: 2, name: lane, exact: true });
  await jump.getByRole("link", { name: new RegExp("^" + lane) }).click();
  await page.waitForTimeout(700);
  const box = await header.boundingBox();
  if (!box || box.x < 0 || box.x + box.width > 1024 || box.y < 0 || box.y > 768) failures.push(lane + " header is out of view after its jump link.");
}
const pageScroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
if (pageScroll > 0) failures.push("The page scrolls sideways by " + pageScroll + "px.");
await browser.close();
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log("PASS: all four lanes reachable at 1024x768");
