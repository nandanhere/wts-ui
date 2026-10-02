import { agentTurnChangesFixture } from "../src/test/agentTurnChangesFixture";
import { MR_CONVERSATION, UNRELATED_DRAFT, expect, mountFeedback, test } from "./fixtures/agentFeedback";
const receipt = () => agentTurnChangesFixture({ conversationId: MR_CONVERSATION, repositoryId: "repo-original-mr", workspaceId: "11111111-1111-4111-8111-111111111111", requestId: "99999999-9999-4999-8999-999999999999" });

test("one result saves an explicit decision and history while preserving the current composer", async ({ page, feedbackOrigin }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 640 });
  const fixture = await mountFeedback(page, feedbackOrigin, { review: receipt() });
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Task changes" });
  const summary = dialog.getByText("Decision · Not set", { exact: true }); await expect(summary).toBeVisible();
  expect(fixture.actionCalls).toEqual([]);
  const code = dialog.locator("diffs-container code"); await expect(code).toContainText("title = 'New'"); expect((await code.boundingBox())!.y + 20).toBeLessThan(632);
  await summary.click(); const decision = dialog.getByRole("region", { name: "Task review decision" });
  await decision.getByRole("radio", { name: "Keep as alternative" }).check(); await decision.getByRole("textbox", { name: "Reason (optional)" }).fill("Compare this with the next result.");
  expect(fixture.actionCalls).toEqual([]);
  await decision.getByRole("button", { name: "Save decision" }).dblclick({ delay: 60 });
  await expect(dialog.getByText("Decision · Alternative", { exact: true })).toBeVisible();
  expect(fixture.actionCalls).toHaveLength(1); expect(fixture.actionCalls[0].request).toMatchObject({ kind: "kept", reason: "Compare this with the next result.", expectedRevision: 0 });
  await decision.getByRole("radio", { name: "Accept result" }).check(); await decision.getByRole("textbox", { name: "Reason (optional)" }).fill("Accept the layout with the known failed check.");
  await decision.getByRole("button", { name: "Save decision" }).click(); await expect(dialog.getByText("Decision · Accepted", { exact: true })).toBeVisible();
  await expect(decision.getByText("unit: Failed", { exact: true }).first()).toBeVisible();
  await decision.getByText("Decision history (1 earlier)", { exact: true }).click(); await expect(decision.getByText("Compare this with the next result.", { exact: true })).toBeVisible();
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("result-decision-history.png") });
  await page.keyboard.press("Escape"); await expect(page.getByRole("textbox", { name: "Message to agent" })).toHaveValue(UNRELATED_DRAFT);
  expect(fixture.sends).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.unexpected).toEqual([]);
});

for (const mode of ["loseBefore", "loseAfter", "conflictOnce"] as const) {
  test(`decision recovery preserves exact intent after ${mode}`, async ({ page, feedbackOrigin }) => {
    const fixture = await mountFeedback(page, feedbackOrigin, { review: receipt(), decisionMode: mode });
    const open = async () => { await page.getByRole("button", { name: "Review changes", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "Task changes" }); await dialog.getByText(/Decision · (Not set|Accepted|Alternative|Rejected)/).click(); return dialog.getByRole("region", { name: "Task review decision" }); };
    let decision = await open(); await decision.getByRole("radio", { name: "Reject result" }).check(); await decision.getByRole("textbox", { name: "Reason (optional)" }).fill("This option hides the reply action.");
    await decision.getByRole("button", { name: "Save decision" }).click(); await expect(decision.getByRole("alert")).toBeVisible(); const first = fixture.actionCalls[0].request;
    if (mode === "conflictOnce") {
      await expect(decision.getByRole("button", { name: "Save decision" })).toBeDisabled();
      await decision.getByRole("button", { name: "Refresh decisions" }).click(); await expect(page.getByText("Decision · Alternative", { exact: true })).toBeVisible();
      expect(fixture.actionCalls).toHaveLength(1); await expect(decision.getByRole("textbox", { name: "Reason (optional)" })).toHaveValue("This option hides the reply action.");
      await decision.getByRole("button", { name: "Save decision" }).click(); expect(fixture.actionCalls[1].request).toMatchObject({ expectedRevision: 1, reason: first!.reason }); expect(fixture.actionCalls[1].request!.requestId).not.toBe(first!.requestId);
    } else {
      await page.reload(); decision = await open(); expect(fixture.actionCalls).toHaveLength(1);
      if (mode === "loseBefore") { await decision.getByRole("button", { name: "Retry decision request" }).click(); expect(fixture.actionCalls[1].request).toEqual(first); }
      else await expect(decision.getByRole("button", { name: "Retry decision request" })).toHaveCount(0);
    }
    await expect(page.getByText("Decision · Rejected", { exact: true })).toBeVisible();
    expect((await fixture.shelf()).drafts.some(draft => draft.body === UNRELATED_DRAFT)).toBe(true); expect(fixture.unexpected).toEqual([]); expect(fixture.sends).toEqual([]);
  });
}
