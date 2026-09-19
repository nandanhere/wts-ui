import { writeFile } from "node:fs/promises";
import type { TestInfo } from "@playwright/test";
import { CHECKOUT, expect, measureInteraction, mountProduct, saveEvidence, screenshot, test } from "./fixtures/productPolish";

async function saveMeasurement(testInfo: TestInfo, name: string, value: unknown) {
  const path = testInfo.outputPath(name);
  await writeFile(path, JSON.stringify(value, null, 2));
  await testInfo.attach(name, { path, contentType: "application/json" });
}

for (const theme of ["light", "dark"] as const) {
  test(`full app navigation and content baseline in ${theme}`, async ({ page, productOrigin }, testInfo) => {
    const fixture = await mountProduct(page, productOrigin, { theme, delayMs: 80 });
    try {
      const checkout = page.getByRole("button", { name: /^Open PLATFORM-42.* details$/i });
      await expect(checkout).toBeVisible();
      await screenshot(page, testInfo, "01-spaces");
      await measureInteraction(page, "cold workspace details", checkout, page.getByLabel("Workspace facts"));
      await screenshot(page, testInfo, "02-workspace");
      await measureInteraction(page, "cold Plans tab", page.getByRole("tab", { name: "Plans", exact: true }), page.getByRole("heading", { name: "Implementation plan", exact: true }));
      await expect(page.getByRole("img", { name: "Mermaid diagram", exact: true })).toBeVisible();
      await screenshot(page, testInfo, "03-plans");
      const planPanel = page.getByRole("region", { name: "Plans and Kanban", exact: true });
      for (const control of [planPanel.getByRole("textbox", { name: "Feedback for PLAN.md", exact: true }), planPanel.getByRole("button", { name: "Current", exact: true }), planPanel.getByRole("button", { name: "Add feedback", exact: true }), planPanel.getByText("No open feedback.", { exact: true })]) {
        const fontSize = await control.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize));
        expect.soft(fontSize, "Plans controls and recovery guidance need readable 12px text.").toBeGreaterThanOrEqual(12);
      }
      await page.getByRole("button", { name: "Open Spaces", exact: true }).click();
      fixture.delay("/planning/", 1_500);
      await measureInteraction(page, "cached Plans workspace return", checkout, page.getByRole("heading", { name: "Implementation plan", exact: true }));
      await screenshot(page, testInfo, "04-plans-cache-return");
      await page.getByRole("tab", { name: /^Changes/ }).click();
      await expect(page.getByRole("combobox", { name: "Code comparison" })).toBeVisible();
      await screenshot(page, testInfo, "05-mr-changes");
      await page.getByRole("tab", { name: /^Conversations/ }).click();
      await expect(page.getByText("Can two requests with the same key race here? Please preserve the original receipt when a retry arrives.")).toBeVisible();
      await screenshot(page, testInfo, "06-conversations");
      await page.getByRole("button", { name: "src/capture.ts:+2 by @priya", exact: true }).click();
      const reply = page.getByRole("textbox", { name: "Reply", exact: true });
      await reply.fill("Keep this reply draft during refresh.");
      const position = () => reply.evaluate(element => element.getBoundingClientRect().top - element.closest('[data-ui="gitlab-conversations.panel"]')!.getBoundingClientRect().top);
      const beforeRefresh = await position();
      fixture.delay("/discussions", 1_500);
      await page.getByRole("button", { name: "Refresh conversations", exact: true }).click();
      await expect(page.getByRole("button", { name: "Refresh conversations", exact: true })).toBeDisabled();
      const duringRefresh = await position();
      await saveMeasurement(testInfo, "conversation-refresh-geometry.json", { beforeRefresh, duringRefresh });
      expect.soft(duringRefresh, "Background refresh must not move the reply composer within its panel.").toBe(beforeRefresh);
      await expect(reply).toHaveValue("Keep this reply draft during refresh.");
      await screenshot(page, testInfo, "07-conversations-refresh");
      await expect(page.getByRole("button", { name: "Refresh conversations", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Open Spaces", exact: true }).click();
      const firstThread = page.getByRole("button", { name: "src/capture.ts:+2 by @priya", exact: true });
      await measureInteraction(page, "cached Conversations workspace return", checkout, firstThread);
      const threadPosition = () => firstThread.evaluate(element => element.getBoundingClientRect().top - element.closest('[data-ui="gitlab-conversations.panel"]')!.getBoundingClientRect().top);
      const cachedThreadPosition = await threadPosition();
      await screenshot(page, testInfo, "07b-conversations-cache-return");
      await expect(page.getByRole("button", { name: "Refresh conversations", exact: true })).toBeEnabled();
      const refreshedThreadPosition = await threadPosition();
      await saveMeasurement(testInfo, "conversation-cache-geometry.json", { cachedThreadPosition, refreshedThreadPosition });
      expect.soft(refreshedThreadPosition, "A cached conversation refresh must not move thread controls.").toBe(cachedThreadPosition);
      await page.getByRole("tab", { name: /^Code/ }).click();
      await page.getByRole("combobox", { name: "Repository to review", exact: true }).click();
      await page.getByRole("option", { name: "payments-sdk", exact: true }).click();
      await expect(page.getByText("captureOnce(request.id, request)", { exact: false }).first()).toBeVisible();
      const diffTypography = await page.locator("diffs-container").first().evaluate(element => {
        const code = element.shadowRoot!.querySelector("code")!;
        const style = getComputedStyle(code);
        return { fontSize: style.fontSize, fontFamily: style.fontFamily, lineHeight: style.lineHeight };
      });
      await saveMeasurement(testInfo, "local-diff-typography.json", diffTypography);
      await screenshot(page, testInfo, "08-local-changes");
      await page.getByRole("button", { name: "Open agent feedback", exact: true }).click();
      await expect(page.getByRole("log", { name: "Agent messages" })).toContainText("Keep workspace navigation stable");
      await screenshot(page, testInfo, "09-feedback");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Open Environment and integrations", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Environment & integrations" })).toBeVisible();
      await screenshot(page, testInfo, "10-settings");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Open Spaces", exact: true }).click();
      await page.getByRole("button", { name: "New workspace", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "New workspace", exact: true })).toBeVisible();
      await screenshot(page, testInfo, "11-create");
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    } finally { await saveEvidence(page, testInfo, fixture); }
  });
}

for (const view of ["Plans", "Conversations"] as const) {
  test(`fifteen cached ${view} workspace returns with delayed transport`, async ({ page, productOrigin }, testInfo) => {
    const fixture = await mountProduct(page, productOrigin, { path: `/sessions/${CHECKOUT}`, theme: "dark", delayMs: 80 });
    try {
      await expect(page.getByLabel("Workspace facts")).toBeVisible();
      if (view === "Plans") {
        await page.getByRole("tab", { name: "Plans", exact: true }).click();
        await expect(page.getByRole("img", { name: "Mermaid diagram", exact: true })).toBeVisible();
      } else {
        await page.getByRole("tab", { name: /^Changes/ }).click();
        await page.getByRole("tab", { name: /^Conversations/ }).click();
      }
      const ready = view === "Plans" ? page.getByRole("heading", { name: "Implementation plan", exact: true }) : page.getByRole("button", { name: "src/capture.ts:+2 by @priya", exact: true });
      await expect(ready).toBeVisible();
      const suffix = view === "Plans" ? "/planning/documents/plan" : "/discussions";
      fixture.delay(view === "Plans" ? "/planning/" : "/discussions", 1_500);
      for (let sample = 1; sample <= 15; sample += 1) {
        await page.getByRole("button", { name: "Open Spaces", exact: true }).click();
        let refreshed = false;
        const response = page.waitForResponse(item => new URL(item.url()).pathname.endsWith(suffix)).then(() => { refreshed = true; });
        await measureInteraction(page, `cached ${view} return ${sample}`, page.getByRole("button", { name: /^Open PLATFORM-42.* details$/i }), ready);
        expect(refreshed, "Cached content must be visible before the delayed refresh finishes.").toBe(false);
        await response;
      }
      expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
    } finally { await saveEvidence(page, testInfo, fixture); }
  });
}

test("medium viewport keeps workspace and Plans controls readable", async ({ page, productOrigin }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const fixture = await mountProduct(page, productOrigin, { theme: "dark", path: `/sessions/${CHECKOUT}` });
  try {
    await expect(page.getByLabel("Workspace facts")).toBeVisible();
    await screenshot(page, testInfo, "01-medium-workspace");
    const headerGeometry = await page.getByRole("banner").first().evaluate(element => ({
      header: { className: element.className, ...element.getBoundingClientRect().toJSON() },
      buttons: [...element.querySelectorAll("button")].map(button => ({ label: button.getAttribute("aria-label") ?? button.textContent, className: button.className, ...button.getBoundingClientRect().toJSON() })),
    }));
    await saveMeasurement(testInfo, "medium-header-geometry.json", headerGeometry);
    for (const button of headerGeometry.buttons) {
      expect.soft(button.bottom, `${button.label} must stay inside the global header.`).toBeLessThanOrEqual(headerGeometry.header.bottom);
    }
    await page.getByRole("tab", { name: "Plans", exact: true }).click();
    await expect(page.getByRole("img", { name: "Mermaid diagram", exact: true })).toBeVisible();
    await screenshot(page, testInfo, "02-medium-plans");
    const width = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    expect(width.scroll).toBe(width.client);
    expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
  } finally { await saveEvidence(page, testInfo, fixture); }
});

test("local source uses a readable platform monospace font", async ({ page, productOrigin }, testInfo) => {
  const fixture = await mountProduct(page, productOrigin, { theme: "dark", path: `/sessions/${CHECKOUT}/changes` });
  try {
    await page.getByRole("combobox", { name: "Repository to review", exact: true }).click();
    await page.getByRole("option", { name: "payments-sdk", exact: true }).click();
    await expect(page.getByText("captureOnce(request.id, request)", { exact: false }).first()).toBeVisible();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const object = await cdp.send("Runtime.evaluate", { expression: "(() => { const code = document.querySelector('diffs-container').shadowRoot.querySelector('code'); const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT); let node; while ((node = walker.nextNode())) { if (node.textContent.includes('captureOnce')) return node.parentElement; } })()" });
    const { nodeId } = await cdp.send("DOM.requestNode", { objectId: object.result.objectId! });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    const style = await page.locator("diffs-container").first().evaluate(element => {
      const code = element.shadowRoot!.querySelector("code")!;
      return { fontSize: getComputedStyle(code).fontSize, fontFamily: getComputedStyle(code).fontFamily };
    });
    await saveMeasurement(testInfo, "rendered-code-font.json", { fonts, style });
    await cdp.detach();
    expect(fonts.filter(font => font.glyphCount > 0).length).toBeGreaterThan(0);
    expect.soft(fonts.filter(font => font.glyphCount > 0 && /^Courier(?: New)?$/i.test(font.familyName)), "Local code must use the intended platform monospace font.").toEqual([]);
    expect.soft(Number.parseFloat(style.fontSize), "Local code needs readable text.").toBeGreaterThanOrEqual(13);
    await screenshot(page, testInfo, "01-rendered-local-code");
    expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
  } finally { await saveEvidence(page, testInfo, fixture); }
});

test("narrow keyboard navigation and reduced motion", async ({ page, productOrigin }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 720 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fixture = await mountProduct(page, productOrigin, { theme: "dark" });
  try {
    const card = page.getByRole("button", { name: /^Open PLATFORM-42.* details$/i });
    await expect(card).toBeVisible();
    await screenshot(page, testInfo, "01-narrow-spaces");
    const command = page.getByRole("button", { name: "Open command palette", exact: true });
    await command.focus(); await page.keyboard.press("Meta+k");
    await expect(page.getByRole("dialog", { name: "Commands", exact: true })).toBeVisible();
    await screenshot(page, testInfo, "02-keyboard-command-palette");
    await page.keyboard.press("Escape"); await expect(command).toBeFocused();
    await card.focus(); await page.keyboard.press("Enter");
    await expect(page.getByLabel("Workspace facts")).toBeVisible();
    await screenshot(page, testInfo, "03-narrow-workspace");
    await page.getByRole("tab", { name: "Plans", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Implementation plan", exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "Mermaid diagram", exact: true })).toBeVisible();
    await screenshot(page, testInfo, "04-narrow-plans");
    const geometry = await page.evaluate(() => {
      const box = (element: Element) => ({ className: element.className, ...element.getBoundingClientRect().toJSON() });
      const title = document.querySelector('[data-ui="workspace.identity"] h1')!;
      const tabs = document.querySelector('[data-ui="workspace.tab-bar"]')!;
      const fileButtons = [...document.querySelectorAll('nav[aria-label="Planning files"] button')];
      const fileName = document.querySelector('[data-ui="planning.document-toolbar"] strong')!;
      return { title: box(title), tabs: box(tabs), fileButtons: fileButtons.map(box), fileName: box(fileName), fileNameSpace: box(fileName.parentElement!) };
    });
    await saveMeasurement(testInfo, "narrow-control-geometry.json", geometry);
    expect.soft(geometry.title.bottom, "Workspace title and tabs need separate visible rows.").toBeLessThanOrEqual(geometry.tabs.top);
    for (let index = 1; index < geometry.fileButtons.length; index += 1) {
      expect.soft(geometry.fileButtons[index - 1].right, "Planning file controls must not overlap.").toBeLessThanOrEqual(geometry.fileButtons[index].left);
    }
    expect.soft(geometry.fileNameSpace.width, "The selected planning file name needs room to read.").toBeGreaterThanOrEqual(120);
    const fileNavigation = page.getByRole("navigation", { name: "Planning files", exact: true });
    await fileNavigation.locator('button[aria-current="page"]').focus();
    await page.keyboard.press("End");
    await expect(fileNavigation.getByRole("button").last()).toBeFocused();
    const lastFile = await fileNavigation.getByRole("button").last().boundingBox();
    const navigation = await fileNavigation.boundingBox();
    expect.soft(lastFile!.x + lastFile!.width, "Keyboard file navigation must reveal the last file.").toBeLessThanOrEqual(navigation!.x + navigation!.width + 1);
    const width = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    expect.soft(width.scroll, "Plans must not overflow the document at 375px.").toBe(width.client);
    await page.getByRole("button", { name: "Open Environment and integrations", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Environment & integrations" })).toBeVisible();
    await screenshot(page, testInfo, "05-narrow-settings");
    await page.keyboard.press("Escape");
    expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
  } finally { await saveEvidence(page, testInfo, fixture); }
});

test("setup and failed cached reads offer recovery", async ({ page, productOrigin }, testInfo) => {
  const fixture = await mountProduct(page, productOrigin, { path: `/sessions/${CHECKOUT}/changes`, theme: "light" });
  try {
    await expect(page.getByRole("combobox", { name: "Code comparison" })).toBeVisible();
    await page.getByRole("combobox", { name: "Repository to review", exact: true }).click();
    await page.getByRole("option", { name: "payments-sdk", exact: true }).click();
    await expect(page.getByText("captureOnce(request.id, request)", { exact: false }).first()).toBeVisible();
    fixture.failNext("/repositories/repo_sdk/diff", 99);
    await page.getByRole("button", { name: "Open Spaces", exact: true }).click();
    await page.getByRole("button", { name: /^Open PLATFORM-42.* details$/i }).click();
    await expect(page.getByRole("button", { name: "Retry changes", exact: true })).toBeVisible();
    await expect(page.getByText("captureOnce(request.id, request)", { exact: false }).first()).toBeVisible();
    await screenshot(page, testInfo, "01-cached-changes-error");
    fixture.failNext("/repositories/repo_sdk/diff", 0);
    await page.getByRole("button", { name: "Retry changes", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry changes", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Open Environment and integrations", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Environment & integrations" })).toBeVisible();
    await screenshot(page, testInfo, "02-integration-guidance");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "My reviews", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No reviews to track", exact: true })).toBeVisible();
    await screenshot(page, testInfo, "03-empty-review-inbox");
    await page.getByRole("button", { name: "Open Spaces", exact: true }).click();
    await page.getByRole("button", { name: "My time", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Work activity", exact: true })).toBeVisible();
    await screenshot(page, testInfo, "04-work-activity");
    expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
  } finally { await saveEvidence(page, testInfo, fixture); }
});

test("short narrow review and feedback keep controls reachable", async ({ page, productOrigin }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 640 });
  const longPath = "packages/payments/checkout/infrastructure/idempotency/ConcurrentCaptureCoordinator.ts";
  const fixture = await mountProduct(page, productOrigin, { theme: "dark", path: `/sessions/${CHECKOUT}/changes`, feedbackQueue: true, longConversationPath: longPath });
  const assertFits = async (selector: import("@playwright/test").Locator) => {
    const box = await selector.boundingBox();
    expect.soft(box!.x, "The control must stay inside the viewport.").toBeGreaterThanOrEqual(0);
    expect.soft(box!.x + box!.width, "The control must stay inside the viewport.").toBeLessThanOrEqual(375);
  };
  try {
    await expect(page.getByRole("combobox", { name: "Code comparison", exact: true })).toBeVisible();
    await expect(page.getByText("captureOnce(request.id, request)", { exact: false }).first()).toBeVisible();
    const comparisonGeometry = await page.evaluate(() => {
      const toolbar = document.querySelector('[data-ui="changes.comparison-toolbar"]')!.getBoundingClientRect();
      const panel = document.querySelector('[data-ui="changes.code"]')!.getBoundingClientRect();
      const code = document.querySelector("diffs-container")!.shadowRoot!.querySelector("code")!.getBoundingClientRect();
      return { toolbar: toolbar.toJSON(), panel: panel.toJSON(), code: code.toJSON(), visibleCodeHeight: Math.max(0, Math.min(code.bottom, innerHeight) - Math.max(code.top, 0)) };
    });
    await saveMeasurement(testInfo, "narrow-comparison-geometry.json", comparisonGeometry);
    expect.soft(comparisonGeometry.toolbar.top, "The comparison controls need room below the MR header.").toBeLessThanOrEqual(370);
    expect.soft(comparisonGeometry.visibleCodeHeight, "The initial view must show part of the selected code.").toBeGreaterThanOrEqual(80);
    await screenshot(page, testInfo, "01-narrow-mr-changes");
    await assertFits(page.getByRole("combobox", { name: "Code comparison", exact: true }));
    const patchToolbar = page.locator('[data-ui="changes.toolbar"]');
    const lastToolbarButton = patchToolbar.getByRole("button", { name: "Diff options", exact: true });
    await lastToolbarButton.focus();
    await assertFits(lastToolbarButton);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Expand file", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(lastToolbarButton).toBeFocused();
    const files = page.getByRole("navigation", { name: "MR and local files", exact: true });
    const lastPublishedFile = files.getByRole("button", { name: /^tests\/capture\.test\.ts / });
    await lastPublishedFile.focus(); await page.keyboard.press("Enter");
    await expect(lastPublishedFile).toHaveAttribute("aria-current", "true");
    await assertFits(lastPublishedFile);
    await expect(page.getByText("expect(captures).toHaveLength(1)", { exact: false }).first()).toBeVisible();
    await files.getByRole("button", { name: /^src\/capture\.ts / }).click();
    await page.getByRole("button", { name: "Open 3 unread comments in checkout-api !16", exact: true }).click();
    const thread = page.getByRole("button", { name: `${longPath}:+2 by @priya`, exact: true });
    await expect(thread).toHaveAttribute("aria-pressed", "true");
    await expect(thread).toBeFocused();
    await assertFits(thread);
    await screenshot(page, testInfo, "02-narrow-conversations");
    const reply = page.getByRole("textbox", { name: "Reply", exact: true });
    await reply.fill("Keep this local reply draft. Do not publish it.");
    const publish = page.getByRole("button", { name: "Reply to GitLab", exact: true });
    const agent = page.getByRole("button", { name: "Ask agent to fix", exact: true });
    await agent.scrollIntoViewIfNeeded();
    await assertFits(reply); await assertFits(publish); await assertFits(agent);
    const publishBox = (await publish.boundingBox())!; const agentBox = (await agent.boundingBox())!;
    const overlap = Math.max(0, Math.min(publishBox.x + publishBox.width, agentBox.x + agentBox.width) - Math.max(publishBox.x, agentBox.x)) * Math.max(0, Math.min(publishBox.y + publishBox.height, agentBox.y + agentBox.height) - Math.max(publishBox.y, agentBox.y));
    expect.soft(overlap, "Reply and agent actions must not overlap.").toBe(0);
    await screenshot(page, testInfo, "03-narrow-reply-actions");
    await page.getByRole("button", { name: "Open agent feedback", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Agent feedback", exact: true });
    const queue = dialog.getByRole("region", { name: "Queued requests", exact: true });
    await expect(queue).toContainText("Keep the selected repository and reply draft");
    const message = dialog.getByRole("textbox", { name: "Message to agent", exact: true });
    await message.scrollIntoViewIfNeeded();
    await assertFits(dialog); await assertFits(message);
    await screenshot(page, testInfo, "04-narrow-feedback-queue");
    await message.hover(); await page.mouse.wheel(0, 500);
    const send = dialog.getByRole("button", { name: "Send to agent", exact: true });
    await expect.poll(async () => { const box = await send.boundingBox(); return box ? box.y + box.height : 1_000; }).toBeLessThanOrEqual(640);
    await screenshot(page, testInfo, "05-narrow-feedback-composer");
    await dialog.getByRole("button", { name: "Close agent feedback", exact: true }).click();
    await expect(reply).toHaveValue("Keep this local reply draft. Do not publish it.");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
    expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
  } finally { await saveEvidence(page, testInfo, fixture); }
});

test("physical outer scrolling belongs to each workspace tab", async ({ page, productOrigin }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  const fixture = await mountProduct(page, productOrigin, { path: `/sessions/${CHECKOUT}`, theme: "light" });
  try {
    const viewport = page.locator('[data-ui="workspace.tab-content"]');
    await expect(page.getByLabel("Workspace facts")).toBeVisible();
    await viewport.hover(); await page.mouse.wheel(0, 420);
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
    const overviewOffset = await viewport.evaluate(element => element.scrollTop);
    await screenshot(page, testInfo, "01-workspace-scrolled");
    await page.getByRole("tab", { name: "Plans", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Implementation plan", exact: true })).toBeVisible();
    expect.soft(await viewport.evaluate(element => element.scrollTop), "A newly opened Plans tab starts at the top.").toBe(0);
    await screenshot(page, testInfo, "02-plans-start");
    await page.getByRole("tab", { name: "Workspace", exact: true }).click();
    await expect(page.getByRole("button", { name: "Run Codex in background", exact: true })).toBeVisible();
    expect.soft(await viewport.evaluate(element => element.scrollTop), "Returning to Workspace restores its outer scroll.").toBe(overviewOffset);
    await page.getByRole("button", { name: "Open Spaces", exact: true }).click();
    await page.getByRole("button", { name: /^Open PLATFORM-42.* details$/i }).click();
    await expect(page.getByRole("button", { name: "Run Codex in background", exact: true })).toBeVisible();
    expect.soft(await viewport.evaluate(element => element.scrollTop), "Returning from Spaces restores the workspace scroll.").toBe(overviewOffset);
    await screenshot(page, testInfo, "03-workspace-return");
    expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
  } finally { await saveEvidence(page, testInfo, fixture); }
});

for (const services of ["empty", "one"] as const) {
  test(`create workspace Services step with ${services} service selection`, async ({ page, productOrigin }, testInfo) => {
    const fixture = await mountProduct(page, productOrigin, { path: "/sessions/new", services });
    try {
      const dialog = page.getByRole("dialog", { name: "New workspace", exact: true });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("textbox", { name: /Jira issue key or URL/ }).fill("POLISH-42");
      await dialog.getByRole("textbox", { name: "Repositories for this plan", exact: true }).fill("checkout-api");
      await dialog.getByRole("button", { name: "Review repositories", exact: true }).click();
      fixture.delay("/runtime-analysis", 1_500);
      const analysisRequest = page.waitForRequest(request => request.url().endsWith("/runtime-analysis"));
      const analysisResponse = page.waitForResponse(response => response.url().endsWith("/runtime-analysis"));
      await dialog.getByRole("button", { name: "Analyze services", exact: true }).click();
      await analysisRequest;
      await screenshot(page, testInfo, "01-services-analysis-pending");
      expect.soft(await dialog.getByText(/WTS found runnable services/).count(), "The pending step must not claim an analysis result.").toBe(0);
      await analysisResponse;
      await expect(dialog.getByRole("button", { name: "Review plan", exact: true })).toBeEnabled();
      await screenshot(page, testInfo, "02-services-result");
      if (services === "empty") {
        expect.soft(await dialog.getByRole("heading", { name: "No services to configure", exact: true }).count()).toBe(1);
        expect.soft(await dialog.getByRole("group", { name: "Service selection summary", exact: true }).count()).toBe(0);
      } else {
        const count = dialog.getByText(/^(preferred ports|ports to reserve)$/).locator("..").locator("b, strong");
        await expect(count).toHaveText("1");
        const includeService = dialog.getByRole("checkbox", { name: "Include Checkout API in runtime plan", exact: true });
        await includeService.locator("xpath=ancestor::label").click();
        await expect(includeService).not.toBeChecked();
        await screenshot(page, testInfo, "03-services-unselected");
        expect.soft(await count.innerText(), "Only selected services contribute ports.").toBe("0");
      }
      await dialog.getByRole("button", { name: "Review plan", exact: true }).click();
      await expect(dialog.getByText("This workspace will not start any runtime services.", { exact: true })).toBeVisible();
      await screenshot(page, testInfo, "04-services-plan");
      expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
    } finally { await saveEvidence(page, testInfo, fixture); }
  });
}
