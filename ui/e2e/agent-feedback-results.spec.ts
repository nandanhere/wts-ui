import { agentTurnChangesFixture } from "../src/test/agentTurnChangesFixture";
import { MR_CONVERSATION, UNRELATED_DRAFT, expect, mountFeedback, test } from "./fixtures/agentFeedback";

for (const viewport of [{ width: 1440, height: 900, theme: "dark" }, { width: 375, height: 640, theme: "light" }]) {
  test(`recorded task review keeps exact context and current draft at ${viewport.width}px`, async ({ page, feedbackOrigin }, testInfo) => {
    await page.setViewportSize(viewport);
    const receipt = agentTurnChangesFixture({ conversationId: MR_CONVERSATION, repositoryId: "repo-original-mr", workspaceId: "11111111-1111-4111-8111-111111111111", requestId: "99999999-9999-4999-8999-999999999999",
      patch: "diff --git a/src/title.ts b/src/title.ts\n--- a/src/title.ts\n+++ b/src/title.ts\n@@ -1 +1 @@\n-export const taskCapture = 1;\n+export const taskCapture = 2;\n" });
    const fixture = await mountFeedback(page, feedbackOrigin, { review: receipt, withCurrentDiff: true });
    await page.locator("html").evaluate((element, theme) => element.setAttribute("data-theme", theme), viewport.theme);
    const result = page.getByRole("log", { name: "Agent messages" }).getByRole("article").filter({ hasText: "The fixture provider timed out." });
    await expect(result.getByRole("button", { name: "Review changes", exact: true })).toBeVisible();
    expect(fixture.reviewReads).toEqual([]);
    await expect(result.getByRole("link", { name: "Open live preview" })).toHaveCount(0);
    await result.getByRole("button", { name: "Review changes", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Task changes", exact: true });
    await expect(dialog.getByRole("link", { name: "Open live preview" })).toHaveAttribute("href", `${feedbackOrigin}/preview/original-mr`);
    await expect(dialog).toContainText("Some files had local changes before this task.");
    await expect(dialog).toContainText("Host checks");
    expect(fixture.reviewReads).toEqual([{ conversationId: receipt.conversationId, requestId: receipt.requestId }]);
    const code = dialog.locator("diffs-container").locator("code");
    await expect(code).toContainText("taskCapture = 1");
    await expect(code).toContainText("taskCapture = 2");
    await expect(code).not.toContainText("currentCapture");
    const firstCode = await code.boundingBox();
    expect(firstCode!.y + 20).toBeLessThan(viewport.height - 8);
    await expect(dialog.getByRole("button", { name: /Undo|Restore|Edit locally/ })).toHaveCount(0);
    const annotations = await page.locator("[data-ui]").evaluateAll(elements => elements.map(element => [element.getAttribute("data-ui"), element.getAttribute("data-ui-label")]));
    expect(new Set(annotations.map(item => item[0])).size).toBe(annotations.length);
    expect(new Set(annotations.map(item => item[1])).size).toBe(annotations.length);
    const ids = await page.evaluate(() => Array.from(document.querySelectorAll("[id]"), element => element.id));
    expect(new Set(ids).size).toBe(ids.length);
    await page.keyboard.press("Control+f");
    await expect(dialog.getByRole("searchbox", { name: "Search changed code" })).toBeFocused();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("recorded-task-changes.png") });
    const rect = await dialog.boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0); expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(result.getByRole("button", { name: "Review changes", exact: true })).toBeFocused();
    await expect(page.getByRole("textbox", { name: "Message to agent" })).toHaveValue(UNRELATED_DRAFT);
    const returned = page.evaluate(() => new Promise<unknown>(resolve => window.addEventListener("wts:return-feedback-selection", event => resolve((event as CustomEvent).detail), { once: true })));
    await result.getByRole("button", { name: "Review changes", exact: true }).click();
    await dialog.getByRole("button", { name: "Return to selection", exact: true }).click();
    expect(await returned).toMatchObject({ source: fixture.saved.get(MR_CONVERSATION)!.source });
    await expect(page.getByRole("dialog", { name: "Agent feedback", exact: true })).toHaveCount(0);
    expect((await fixture.shelf()).drafts.some(item => item.body === UNRELATED_DRAFT)).toBe(true);
    expect(fixture.sends).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.unexpected).toEqual([]);
  });
}

test("host checks and exact restore stay with their result and never run on open", async ({ page, feedbackOrigin }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 640 });
  const receipt = agentTurnChangesFixture({ conversationId: MR_CONVERSATION, repositoryId: "repo-original-mr", workspaceId: "11111111-1111-4111-8111-111111111111", requestId: "99999999-9999-4999-8999-999999999999" });
  const fixture = await mountFeedback(page, feedbackOrigin, { review: receipt, reviewActions: true });
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Task changes" });
  await expect(dialog.getByText("Host checks", { exact: true })).toBeVisible(); expect(fixture.actionCalls).toEqual([]);
  await dialog.getByText("Host checks", { exact: true }).click();
  const checks = dialog.getByRole("region", { name: "Host checks", exact: true });
  await checks.getByRole("button", { name: "Run Unit tests" }).dblclick({ delay: 60 });
  await expect(checks.getByText("Unit tests · Failed", { exact: true })).toBeVisible();
  expect(fixture.actionCalls.filter(call => call.method === "POST" && call.action === "checks")).toHaveLength(1);
  await checks.getByText("Unit tests · Failed", { exact: true }).click();
  await expect(checks.getByText("Expected title: Workspace\nActual title: Untitled", { exact: true })).toBeVisible();
  await dialog.getByText("Restore task changes", { exact: true }).click();
  const restore = dialog.getByRole("region", { name: "Restore task changes" });
  await expect(restore).toContainText("src/title.ts");
  expect(fixture.actionCalls.filter(call => call.method === "POST" && call.action === "restore")).toEqual([]);
  await expect(restore).toContainText("Keep other editors and Git tools idle");
  await restore.getByRole("button", { name: "Restore 1 file" }).click();
  await expect(restore).toContainText("WTS restored the listed files.");
  expect(fixture.actionCalls.filter(call => call.method === "POST" && call.action === "restore")).toHaveLength(1);
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("host-check-and-restore.png") });
  const opened = page.evaluate(() => new Promise<unknown>(resolve => window.addEventListener("wts:open-agent-workspace", event => resolve((event as CustomEvent).detail), { once: true })));
  await checks.getByRole("link", { name: "Open workspace verification" }).click();
  expect(await opened).toEqual({ workspaceId: receipt.workspaceId, repositoryId: receipt.repositoryId, tab: "verification" });
  await expect(dialog).toHaveCount(0); await expect(page.getByRole("dialog", { name: "Agent feedback" })).toHaveCount(0);
  expect((await fixture.shelf()).drafts.some(item => item.body === UNRELATED_DRAFT)).toBe(true);
  expect(fixture.sends).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.unexpected).toEqual([]);
});

for (const action of ["check", "restore"] as const) {
  test(`an uncertain ${action} keeps its exact mutation across reload`, async ({ page, feedbackOrigin }) => {
    const receipt = agentTurnChangesFixture({ conversationId: MR_CONVERSATION, repositoryId: "repo-original-mr", workspaceId: "11111111-1111-4111-8111-111111111111", requestId: "99999999-9999-4999-8999-999999999999" });
    const fixture = await mountFeedback(page, feedbackOrigin, { review: receipt, reviewActions: true, loseActionOnce: action });
    const open = async () => { await page.getByRole("button", { name: "Review changes", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "Task changes" }); await dialog.getByText(action === "check" ? "Host checks" : "Restore task changes", { exact: true }).click(); return dialog; };
    let dialog = await open(); await dialog.getByRole("button", { name: action === "check" ? "Run Unit tests" : "Restore 1 file" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible(); const first = fixture.actionCalls.find(call => call.method === "POST")!;
    await page.reload(); dialog = await open();
    await expect(dialog.getByRole("button", { name: `Retry ${action} request` })).toBeEnabled();
    expect(fixture.actionCalls.filter(call => call.method === "POST")).toHaveLength(1);
    await dialog.getByRole("button", { name: `Retry ${action} request` }).click();
    await expect(dialog.getByRole("button", { name: `Retry ${action} request` })).toHaveCount(0);
    expect(fixture.actionCalls.filter(call => call.method === "POST").map(call => call.request)).toEqual([first.request, first.request]);
    expect((await fixture.shelf()).drafts.some(item => item.body === UNRELATED_DRAFT)).toBe(true);
    expect(fixture.unexpected).toEqual([]); expect(fixture.sends).toEqual([]);
  });
}
