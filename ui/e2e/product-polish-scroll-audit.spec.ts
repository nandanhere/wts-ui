import { ORDERS, REPORTING, expect, mountProduct, saveEvidence, screenshot, test, type CodeReviewFixture } from "./fixtures/productPolish";
import { repositoryCatalogFixture } from "./fixtures/productPolishData";
import { expectScrollable } from "./fixtures/scrollAudit";

// Each screen must let the user reach all of its content. Run this file in WebKit, the engine of the macOS app.
const oid = (letter: string) => letter.repeat(40);

function longReview(): CodeReviewFixture {
  const findings = Array.from({ length: 14 }, (_, index) => ({
    findingId: `f-${index}`, severity: index % 3 ? "suggestion" : "warning", label: index % 3 ? "question" : "issue",
    repositoryId: "repo_orders", filePath: index % 2 ? "src/idempotency.ts" : "src/capture.ts", line: 2, side: "additions", anchored: index < 2,
    title: `Finding ${index + 1}: check the retry path`, explanation: "Two requests with one key can pass the check together. ".repeat(4),
    suggestedComment: "Issue: hold a lock for the key during the capture.",
  }));
  return {
    runs: [], posted: [],
    review: (request) => ({
      schemaVersion: 2, workspaceId: ORDERS, provider: "codex", scope: "recentChanges", mode: "raptik",
      skill: { id: String(request.skill), label: "Raptik rules", reviewer: "Pratik" }, outcome: "reviewed",
      summary: "Many findings. The list is longer than the screen.", findings, actionableSteps: [],
      repositories: [{ repositoryId: "repo_orders", repositoryLabel: "orders-api", baseCommitOid: oid("a"), headCommitOid: oid("b"), patchSha256: "sha256:mr", changedLines: 6, sizeGateExceeded: false, strictness: "normal",
        mergeRequest: { iid: 16, baseCommitOid: oid("a"), startCommitOid: oid("a"), headCommitOid: oid("b") } }],
      reviewedAtUnixMs: Date.now(),
    }),
  };
}

test("every main screen lets the user scroll to all of its content", async ({ page, productOrigin }, testInfo) => {
  const fixture = await mountProduct(page, productOrigin, { theme: "dark", path: `/sessions/${ORDERS}`, codeReview: longReview() });
  try {
    const bar = page.locator('[data-ui="repository-review.views"]');
    await page.getByRole("tab", { name: /^(Changes|Code review)/ }).click();
    await expect(page.getByRole("combobox", { name: "Code comparison" })).toBeVisible();
    await expectScrollable(page, "Code review");

    await bar.getByRole("button", { name: "AI review" }).click();
    const card = page.getByRole("region", { name: "AI code review" });
    await card.getByRole("button", { name: "Review code" }).click();
    await expect(card.getByRole("list", { name: "Agent questions" })).toBeVisible();
    await screenshot(page, testInfo, "code-review-with-ai-review");
    await expectScrollable(page, "Code review with an AI review");
    // The open AI review shows at full height. The code view scrolls down to a full-height diff.
    const review = page.locator('[data-ui="verification.code-review"]');
    const view = review.locator("xpath=../..");
    const metrics = await view.evaluate((element) => {
      const card = element.querySelector('[data-ui="verification.code-review"]')!;
      const slot = card.parentElement!;
      const diff = slot.nextElementSibling as HTMLElement;
      return { overflowY: getComputedStyle(element).overflowY, view: element.clientHeight, scroll: element.scrollHeight,
        slot: slot.clientHeight, slotScroll: slot.scrollHeight, card: card.getBoundingClientRect().height, diff: diff.getBoundingClientRect().height };
    });
    expect(metrics.overflowY).toBe("auto");
    expect(metrics.slotScroll, "The AI review is not cut by a height cap.").toBeLessThanOrEqual(metrics.slot + 1);
    expect(metrics.card, "The AI review is taller than the old 380 px cap.").toBeGreaterThan(380);
    expect(metrics.diff, "The diff keeps the full height of the view.").toBeGreaterThanOrEqual(metrics.view - 1);
    expect(metrics.scroll).toBeGreaterThan(metrics.view);
+    await view.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
    await expect(page.getByRole("combobox", { name: "Code comparison" })).toBeInViewport();

    await bar.getByRole("tab", { name: /^Conversations/ }).click();
    await expectScrollable(page, "Conversations");

    for (const tab of [/^(Overview|Workspace)/, /^(Plans|Agent review)/]) {
      const target = page.getByRole("tab", { name: tab }).first();
      if (!(await target.count())) continue;
      await target.click();
      await expectScrollable(page, `Workspace tab ${tab}`);
    }

    await page.goto(`${productOrigin}/sessions/${REPORTING}`);
    await expectScrollable(page, "Second workspace");

    await page.getByRole("button", { name: "Open Spaces", exact: true }).click();
    await expect(page.locator('[data-ui="spaces.lanes"]')).toBeVisible();
    await expectScrollable(page, "Spaces board");

    await page.getByRole("button", { name: "Open Environment and integrations", exact: true }).click();
    await expectScrollable(page, "Environment and integrations");

    for (const path of ["/reviews", "/time"]) {
      await page.goto(`${productOrigin}${path}`);
      await page.waitForLoadState("networkidle");
      await expectScrollable(page, path);
    }
    // WebKit reports a harmless ResizeObserver loop notice during layout. Other page errors fail the audit.
    expect(fixture.errors.filter((error) => !error.startsWith("ResizeObserver loop"))).toEqual([]);
  } finally {
    await saveEvidence(page, testInfo, fixture);
  }
});

test("the base branch menu fits the window, scrolls, and starts with the usual bases", async ({ page, productOrigin }, testInfo) => {
  const fixture = await mountProduct(page, productOrigin, { theme: "dark", path: "/sessions/new" });
  const names = ["DEVTOOLS-5920", "DEVTOOLS-6409", "automation/codeowners-20260601-release-train", "dev/bump-version", "develop", "feat/DEVTOOLS-6330", "feat/USB-NIC-DISABLE", "local-sam", "main", "sam_develop", "review/archive-2026-09-20/beacon-long-branch-name",
    ...Array.from({ length: 27 }, (_, index) => `topic/branch-${index + 1}`)];
  await page.route("**/api/v1/repositories", async (route) => {
    const catalog = repositoryCatalogFixture() as ReturnType<typeof repositoryCatalogFixture> & { repositories: Array<Record<string, unknown>> };
    catalog.repositories[0].defaultBranch = { name: "main", fullRef: "refs/remotes/origin/main", commitOid: oid("a") };
    catalog.repositories[0].originUrl = "git@gitlab.example.com:infra/orders-api.git";
    catalog.repositories[0].availableBranches = [
      ...names.map((name) => ({ name, fullRef: name === "develop" ? `refs/heads/${name}` : `refs/remotes/origin/${name}`, commitOid: oid("b"), remote: name !== "develop" })),
      // The server lists origin/develop next to a local develop.
      { name: "develop", fullRef: "refs/remotes/origin/develop", commitOid: oid("c"), remote: true },
    ];
    await route.fulfill({ json: catalog });
  });
  try {
    const dialog = page.getByRole("dialog", { name: "New workspace", exact: true });
    await dialog.getByRole("textbox", { name: /Jira issue key or URL/ }).fill("POLISH-42");
    await dialog.getByRole("textbox", { name: "Repositories for this plan", exact: true }).fill("orders-api");
    await dialog.getByRole("button", { name: "Review repositories", exact: true }).click();
    await dialog.getByRole("combobox", { name: /^Base branch for orders-api/ }).click();
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    await screenshot(page, testInfo, "base-branch-menu");

    const options = listbox.getByRole("option");
    await expect(options).toHaveCount(names.length + 1);
    expect((await options.allInnerTexts()).slice(0, 3), "The default and the usual bases come first.").toEqual(["main · origin", "develop · local", "develop · origin"]);

    const menu = listbox.locator("xpath=ancestor-or-self::*[contains(@class, 'popover')][1]");
    const box = (await menu.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.y, "The menu starts inside the window.").toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, "The menu ends inside the window.").toBeLessThanOrEqual(viewport.height);
    // The menu must be on top at its top and bottom edges. A dialog that clips it or a footer that covers it fails here.
    const coveredEdges = await menu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      return [rect.top + 3, rect.bottom - 3].filter((y) => {
        const hit = document.elementFromPoint(x, y);
        return !hit || !element.contains(hit);
      });
    });
    expect(coveredEdges, "No part of the dialog clips or covers the menu.").toEqual([]);
    const last = options.last();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let step = 0; step < 12; step += 1) await page.mouse.wheel(0, 400);
    await expect(last).toBeInViewport({ ratio: 1 });
    const lastBox = (await last.boundingBox())!;
    expect(lastBox.y + lastBox.height, "A wheel scroll reaches the last branch inside the menu.").toBeLessThanOrEqual(box.y + box.height + 1);
    const longOption = options.filter({ hasText: "automation/codeowners" });
    expect(await longOption.evaluate((element) => { const label = element.querySelector("span")!; return label.scrollWidth <= label.clientWidth + 1; }), "Long branch names show in full.").toBe(true);

    await listbox.getByRole("option", { name: "develop · origin", exact: true }).click();
    await expect(dialog.getByRole("combobox", { name: /^Base branch for orders-api/ }), "The origin branch stays selected, not its local twin.").toHaveText("develop · origin");
    await expect(dialog.getByRole("combobox", { name: /^Base branch for orders-api/ })).toHaveJSProperty("value", "origin/develop");

    // A long branch name stays inside the select box. It must not run under the Refresh button.
    await dialog.getByRole("combobox", { name: /^Base branch for orders-api/ }).click();
    await page.getByRole("listbox").getByRole("option", { name: /automation\/codeowners/ }).click();
    const trigger = dialog.locator("[data-select-trigger]").filter({ hasText: "automation/codeowners" });
    const refresh = dialog.getByRole("button", { name: "Fetch current branches for orders-api from origin" });
    const [triggerBox, refreshBox] = [(await trigger.boundingBox())!, (await refresh.boundingBox())!];
    await screenshot(page, testInfo, "base-branch-long-name");
    expect(triggerBox.x + triggerBox.width, "The select box ends before the Refresh button.").toBeLessThanOrEqual(refreshBox.x);
    expect(await trigger.locator("svg").last().evaluate((chevron) => {
      const rect = chevron.getBoundingClientRect();
      return chevron.closest("[data-select-trigger]")!.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    }), "The select arrow shows.").toBe(true);
    expect(fixture.errors.filter((error) => !error.startsWith("ResizeObserver loop"))).toEqual([]);
  } finally {
    await saveEvidence(page, testInfo, fixture);
  }
});

test("a ready card shows a short start action that blends into the card", async ({ page, productOrigin }, testInfo) => {
  const fixture = await mountProduct(page, productOrigin, { theme: "dark", path: `/sessions/${ORDERS}` });
  try {
    await page.getByRole("button", { name: "Open Spaces", exact: true }).click();
    const lanes = page.locator('[data-ui="spaces.lanes"]');
    await expect(lanes).toBeVisible();
    const start = lanes.getByRole("button").filter({ hasText: /^Start work$/ });
    await expect(start).toBeVisible();
    const open = lanes.getByRole("button").filter({ hasText: /^Open workspace$/ }).first();
    const create = page.getByRole("button", { name: "New workspace", exact: true });
    const look = (target: typeof start) => target.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, borderColor: style.borderTopColor, color: style.color, border: style.borderTopWidth, height: element.getBoundingClientRect().height };
    });
    const [startLook, openLook, createLook] = await Promise.all([look(start), look(open), look(create)]);
    await screenshot(page, testInfo, "spaces-start-work");
    expect(startLook.background, "The card action is not a second solid primary button.").not.toBe(createLook.background);
    expect(startLook.color).not.toBe(createLook.color);
    expect(startLook.border, "The card action keeps the same box size as the other card buttons.").toBe(openLook.border);
    expect(startLook.height).toBe(openLook.height);
    expect(startLook.background, "The start action has no fill on the card.").toBe("rgba(0, 0, 0, 0)");
    expect(startLook.borderColor, "The start action has no outline on the card.").toBe("rgba(0, 0, 0, 0)");
  } finally {
    await saveEvidence(page, testInfo, fixture);
  }
});
