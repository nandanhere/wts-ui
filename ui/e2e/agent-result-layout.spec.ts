import { agentTurnChangesFixture } from "../src/test/agentTurnChangesFixture";
import { MR_CONVERSATION, UNRELATED_DRAFT, expect, mountFeedback, test } from "./fixtures/agentFeedback";

for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 640 }]) {
  for (const state of ["unavailable", "error"] as const) {
    test(`task record ${state} keeps recovery visible at ${viewport.width}px`, async ({ page, feedbackOrigin }, testInfo) => {
      await page.setViewportSize(viewport);
      const receipt = agentTurnChangesFixture({
        conversationId: MR_CONVERSATION, repositoryId: "repo-original-mr",
        workspaceId: "11111111-1111-4111-8111-111111111111", requestId: "99999999-9999-4999-8999-999999999999",
        state: "unavailable", before: undefined, after: undefined, files: [], patch: "",
        detail: "This saved task has no file change record.",
      });
      const fixture = await mountFeedback(page, feedbackOrigin, { review: receipt });
      if (state === "error") {
        await page.route("**/messages/*/changes", route => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "agent_conversation_not_found", message: "This task change record is not available.", retryable: false } }) }));
      }
      const trigger = page.getByRole("button", { name: "Review changes", exact: true });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Task changes", exact: true });
      const summary = dialog.locator('[data-ui="agent-result.summary"]');
      await expect(summary).toContainText(state === "unavailable"
        ? "This task has no complete change record. Open the current local changes to inspect the workspace."
        : "This task change record is not available.");
      const geometry = await summary.evaluate(element => {
        const body = element.parentElement!;
        const dialog = body.parentElement!;
        const rect = body.getBoundingClientRect();
        return { bodyHeight: rect.height, bodyTop: rect.top, bodyBottom: rect.bottom, dialogBottom: dialog.getBoundingClientRect().bottom, viewportHeight: innerHeight };
      });
      await testInfo.attach("result-layout.json", { body: JSON.stringify(geometry), contentType: "application/json" });
      expect(geometry.bodyHeight).toBeGreaterThanOrEqual(100);
      expect(geometry.bodyBottom).toBeLessThanOrEqual(geometry.dialogBottom);
      expect(geometry.bodyBottom).toBeLessThanOrEqual(geometry.viewportHeight);
      const recovery = dialog.getByRole("link", { name: "View current local changes", exact: true });
      const recoveryRect = await recovery.boundingBox();
      expect(recoveryRect!.y).toBeGreaterThanOrEqual(geometry.bodyTop);
      expect(recoveryRect!.y + recoveryRect!.height).toBeLessThanOrEqual(geometry.bodyBottom);
      await page.screenshot({ animations: "disabled", path: testInfo.outputPath("task-record-recovery.png") });
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await expect(page.getByRole("textbox", { name: "Message to agent" })).toHaveValue(UNRELATED_DRAFT);
      await trigger.click();
      const opened = page.evaluate(() => new Promise<unknown>(resolve => window.addEventListener("wts:open-agent-workspace", event => resolve((event as CustomEvent).detail), { once: true })));
      await page.getByRole("dialog", { name: "Task changes", exact: true }).getByRole("link", { name: "View current local changes", exact: true }).click();
      expect(await opened).toEqual({ workspaceId: receipt.workspaceId, repositoryId: receipt.repositoryId });
      await expect(dialog).toHaveCount(0);
      expect(fixture.sends).toEqual([]);
      expect(fixture.mutations).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  }
}
