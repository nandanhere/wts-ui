import { test, expect } from "@playwright/test";
import { findStuckScrollers, findTrappedContent } from "./fixtures/scrollAudit";

// Read-only scroll audit against a running WTS server with real workspaces. It only opens views.
// Usage: WTS_REAL_URL=http://127.0.0.1:18990 npm run test:desktop-webkit -- real-desktop-scroll-audit
const origin = process.env.WTS_REAL_URL;
const maxWorkspaces = Number(process.env.WTS_TOUR_WORKSPACES ?? 4);

test.skip(!origin, "Set WTS_REAL_URL to a WTS server that holds real workspaces.");
test.setTimeout(10 * 60_000);

test("real workspaces let the user scroll to all content", async ({ page }, testInfo) => {
  const problems: Array<{ screen: string; trapped: unknown[]; stuck: string[] }> = [];
  const visited: string[] = [];
  const audit = async (screen: string) => {
    await page.waitForTimeout(1200);
    visited.push(screen);
    const trapped = await findTrappedContent(page);
    const stuck = await findStuckScrollers(page);
    if (trapped.length || stuck.length) {
      problems.push({ screen, trapped, stuck });
      await page.screenshot({ path: testInfo.outputPath(`problem-${problems.length}.png`) });
    }
  };
  const openTab = async (name: RegExp) => {
    const tab = page.getByRole("tab", { name }).first();
    if (!(await tab.count())) return false;
    await tab.click();
    return true;
  };
  const home = async () => {
    await page.goto(origin!);
    await page.locator('[data-ui="spaces.lanes"]').waitFor({ timeout: 30_000 });
  };

  await home();
  await audit("Spaces board");
  const labels = await page.getByRole("button", { name: /^Open .* details$/ }).evaluateAll((cards) => cards.map((card) => card.getAttribute("aria-label") ?? ""));
  for (const label of labels.slice(0, maxWorkspaces)) {
    await home();
    await page.getByRole("button", { name: label, exact: true }).first().click();
    const name = label.replace(/^Open | details$/g, "");
    await audit(`${name}: overview`);
    if (await openTab(/^(Plans|Agent review)/)) await audit(`${name}: plans`);
    if (await openTab(/^(Changes|Code review)/)) {
      await page.locator('[data-ui="changes.comparison-loading"]').waitFor({ state: "detached", timeout: 20_000 }).catch(() => undefined);
      await audit(`${name}: code review`);
      const views = page.locator('[data-ui="repository-review.views"]');
      const aiReview = views.getByRole("button", { name: "AI review" });
      if (await aiReview.count()) { await aiReview.click(); await audit(`${name}: code review with the AI review panel`); }
      const conversations = views.getByRole("tab", { name: /^Conversations/ });
      if (await conversations.count()) { await conversations.click(); await audit(`${name}: conversations`); }
    }
    if (await openTab(/^Verify$/)) await audit(`${name}: verify`);
  }
  for (const path of ["/reviews", "/time"]) {
    await page.goto(`${origin}${path}`);
    await audit(path);
  }
  console.log(`Audited ${visited.length} screens:\n${visited.join("\n")}`);
  await testInfo.attach("scroll-problems.json", { body: JSON.stringify(problems, null, 2), contentType: "application/json" });
  expect(problems).toEqual([]);
});
