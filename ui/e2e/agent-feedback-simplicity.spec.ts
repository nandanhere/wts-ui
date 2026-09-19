import { agentTurnChangesFixture } from "../src/test/agentTurnChangesFixture";
import { MR_CONVERSATION, SELECTED_DRAFT, UNRELATED_DRAFT, expect, mountFeedback, test } from "./fixtures/agentFeedback";

for (const width of [1440, 375]) {
  test(`feedback keeps recovery simple and secondary controls reachable at ${width}px`, async ({ page, feedbackOrigin }, testInfo) => {
    await page.setViewportSize({ width, height: width === 375 ? 720 : 900 });
    const receipt = agentTurnChangesFixture({ conversationId: MR_CONVERSATION, repositoryId: "repo-original-mr",
      workspaceId: "11111111-1111-4111-8111-111111111111", requestId: "99999999-9999-4999-8999-999999999999",
      state: "unavailable", before: undefined, after: undefined, files: [], patch: "", detail: "This task has no saved file record." });
    const fixture = await mountFeedback(page, feedbackOrigin, { review: receipt });
    const saved = fixture.saved.get(MR_CONVERSATION)!;
    fixture.saved.clear(); fixture.saved.set(MR_CONVERSATION, { ...saved,
      messages: saved.messages.map((message, index) => ({ ...message, createdAtUnixMs: 30 + index })) });
    for (let attempt = 0; attempt < 3; attempt++) {
      const older = structuredClone(saved);
      older.conversationId = `${attempt + 4}2222222-2222-4222-8222-222222222222`;
      older.messages = older.messages.map((message, index) => ({ ...message,
        messageId: `history-${attempt}-${index}`, requestId: `history-${attempt}`, createdAtUnixMs: 3 * attempt + index,
        ...(message.role === "assistant" ? { error: "An earlier attempt stopped.", body: "Saved provider output.\n".repeat(20) } : { body: `Earlier request ${attempt + 1}` }) }));
      fixture.saved.set(older.conversationId, older);
    }
    await page.evaluate(({ id, conversationId }) => {
      const key = "wts.agent-feedback.shelf.v2";
      const shelf = JSON.parse(localStorage.getItem(key)!);
      const selected = shelf.drafts.find((draft: { id: string }) => draft.id === id);
      selected.conversationId = conversationId;
      localStorage.setItem(key, JSON.stringify(shelf));
    }, { id: SELECTED_DRAFT, conversationId: MR_CONVERSATION });
    await page.reload();
    const bubble = page.getByRole("dialog", { name: "Agent feedback", exact: true });
    const log = bubble.getByRole("log", { name: "Agent messages" });
    const result = log.getByRole("article").filter({ hasText: "The fixture provider timed out." });
    await expect(result).toBeVisible();
    await expect(result.getByRole("button")).toHaveText(["Review changes", "Retry"]);
    await expect(result.getByRole("link")).toHaveCount(0);
    await expect(bubble.getByRole("button", { name: "Feedback agent" })).toHaveCount(0);
    await expect(bubble.getByText("0 active · 0 queued", { exact: true })).toHaveCount(0);
    await expect(bubble.getByText(/^Saved drafts/)).toHaveCount(0);
    await expect(bubble.getByRole("button", { name: "Refresh tasks" })).toHaveCount(0);
    const composer = bubble.getByRole("textbox", { name: "Message to agent" });
    await expect(composer).toHaveValue(UNRELATED_DRAFT);
    const send = bubble.getByRole("button", { name: "Send to agent", exact: true });
    const bubbleBounds = await bubble.boundingBox();
    await page.mouse.move(bubbleBounds!.x + 80, bubbleBounds!.y + 140);
    await page.mouse.wheel(0, -5000);
    await expect(log.getByText("Earlier request 1", { exact: true })).toBeInViewport();
    const sendBounds = await send.boundingBox();
    expect(sendBounds!.y).toBeGreaterThanOrEqual(0);
    expect(sendBounds!.y + sendBounds!.height).toBeLessThanOrEqual(width === 375 ? 720 : 900);
    await result.getByRole("button", { name: "Review changes" }).click();
    const review = page.getByRole("dialog", { name: "Task changes", exact: true });
    await expect(review.getByRole("link", { name: "View current local changes" })).toBeVisible();
    expect(fixture.reviewReads).toEqual([{ conversationId: receipt.conversationId, requestId: receipt.requestId }]);
    await page.keyboard.press("Escape");
    await expect(result.getByRole("button", { name: "Review changes" })).toBeFocused();
    const options = bubble.getByRole("button", { name: "Feedback options" });
    await options.click();
    await expect(page.getByRole("menuitem", { name: "Refresh tasks" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(options).toBeFocused();
    await expect(bubble).toBeVisible();
    await expect(composer).toHaveValue(UNRELATED_DRAFT);
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((element, value) => element.setAttribute("data-theme", value), theme);
      await composer.scrollIntoViewIfNeeded();
      const bounds = await composer.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(width === 375 ? 720 : 900);
      await page.screenshot({ animations: "disabled", path: testInfo.outputPath(`feedback-simple-${theme}-${width}.png`) });
    }
    expect(fixture.sends).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.unexpected).toEqual([]);
  });
}
