import {
  ACTIVE_CONVERSATION, MR_CONVERSATION, ORIGINAL_MR_TASK, QUEUED_MESSAGE,
  QUEUED_TASK, SELECTED_DRAFT, UNRELATED_DRAFT, expect, mountFeedback, test,
} from "./fixtures/agentFeedback";

function failedRequest(page: import("@playwright/test").Page) {
  return page.getByRole("log", { name: "Agent messages" }).getByRole("article")
    .filter({ hasText: "The fixture provider timed out." });
}

test("one transcript sends an older MR continuation once and keeps the current draft", async ({ page, feedbackOrigin }, testInfo) => {
  const fixture = await mountFeedback(page, feedbackOrigin);
  const log = page.getByRole("log", { name: "Agent messages" });
  await expect(log.getByText(ORIGINAL_MR_TASK, { exact: true })).toBeVisible();
  await expect(log).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "Agent tasks" })).toHaveCount(0);
  await expect(page.getByText("Chats", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message to agent" })).toHaveValue(UNRELATED_DRAFT);
  await expect(log.getByRole("article")).toHaveCount(4);
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("feedback-transcript-desktop.png") });

  await failedRequest(page).getByRole("button", { name: "Retry", exact: true }).dblclick({ delay: 80 });
  await expect.poll(() => fixture.sends.length).toBe(1);
  expect(fixture.sends[0].conversationId).toBe(MR_CONVERSATION);
  expect(fixture.sends[0].request.body).toContain(ORIGINAL_MR_TASK);
  expect(fixture.sends[0].request.body).not.toContain(UNRELATED_DRAFT);
  await expect(failedRequest(page)).toContainText("Continuation queued");
  await expect(page.getByRole("region", { name: "Queued requests" })).toContainText(ORIGINAL_MR_TASK);
  await expect(page.getByRole("textbox", { name: "Message to agent" })).toHaveValue(UNRELATED_DRAFT);
  expect((await fixture.shelf()).selectedId).toBe(SELECTED_DRAFT);

  await page.reload();
  await expect(failedRequest(page)).toContainText("Continuation queued");
  await expect(failedRequest(page).getByRole("button", { name: "Sent", exact: true })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "Message to agent" })).toHaveValue(UNRELATED_DRAFT);
  expect(fixture.sends).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
  await page.locator("html").evaluate(element => element.setAttribute("data-theme", "dark"));
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("feedback-transcript-desktop-dark.png") });
  await page.locator("html").evaluate(element => element.removeAttribute("data-theme"));
  await log.locator("..").evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("feedback-transcript-desktop-history.png") });
});

test("pending continuation clicks share one request and keep the composer usable", async ({ page, feedbackOrigin }) => {
  const fixture = await mountFeedback(page, feedbackOrigin, { sendMode: "deferred" });
  try {
    await failedRequest(page).getByRole("button", { name: "Retry", exact: true }).dblclick({ delay: 20 });
    await expect.poll(() => fixture.sends.length).toBe(1);
    await expect(failedRequest(page).getByRole("button", { name: "Send pending", exact: true })).toBeDisabled();
    const composer = page.getByRole("textbox", { name: "Message to agent" });
    await expect(composer).toBeEnabled();
    await composer.fill(`${UNRELATED_DRAFT} More detail.`);
    fixture.release();
    await expect(failedRequest(page)).toContainText("Continuation queued");
    await expect(composer).toHaveValue(`${UNRELATED_DRAFT} More detail.`);
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.sends[0].conversationId).toBe(MR_CONVERSATION);
    expect(fixture.unexpected).toEqual([]);
  } finally { fixture.release(); }
});

test("an uncertain continuation survives reload and retries its exact original request", async ({ page, feedbackOrigin }) => {
  const fixture = await mountFeedback(page, feedbackOrigin, { sendMode: "loseOnce" });
  await failedRequest(page).getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry send" })).toBeVisible();
  const original = structuredClone(fixture.sends[0]);
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry send" })).toBeVisible();
  expect(fixture.sends).toHaveLength(1);
  await page.getByRole("button", { name: "Retry send" }).dblclick({ delay: 80 });
  await expect(failedRequest(page)).toContainText("Continuation queued");
  expect(fixture.sends).toHaveLength(2);
  expect(fixture.sends[1]).toEqual(original);
  expect(fixture.mutations).toHaveLength(0);
  await expect(page.getByRole("textbox", { name: "Message to agent" })).toHaveValue(UNRELATED_DRAFT);
  expect(fixture.unexpected).toEqual([]);
});

test("queue edits and cancellation use the row context while another draft stays selected", async ({ page, feedbackOrigin }) => {
  const fixture = await mountFeedback(page, feedbackOrigin);
  const queue = page.getByRole("region", { name: "Queued requests" });
  await expect(queue).toContainText(QUEUED_TASK);
  await queue.getByRole("button", { name: "Edit queued request" }).click();
  await queue.getByRole("textbox", { name: "Queued request" }).fill("Updated repository-label fix.");
  await queue.getByRole("button", { name: "Save queued edit" }).click();
  await expect(queue).toContainText("Updated repository-label fix.");
  await expect(queue.getByRole("button", { name: "Cancel request" })).toBeVisible();
  expect(fixture.mutations).toHaveLength(1);
  expect(fixture.mutations[0]).toMatchObject({ conversationId: ACTIVE_CONVERSATION, messageId: QUEUED_MESSAGE,
    action: "edit", request: { expectedBody: QUEUED_TASK, body: "Updated repository-label fix." } });
  await queue.getByRole("button", { name: "Cancel request" }).click();
  await expect(queue).toHaveCount(0);
  expect(fixture.mutations[1]).toMatchObject({ conversationId: ACTIVE_CONVERSATION, messageId: QUEUED_MESSAGE,
    action: "cancel", request: { expectedBody: "Updated repository-label fix." } });
  expect(fixture.sends).toHaveLength(0);
  await expect(page.getByRole("textbox", { name: "Message to agent" })).toHaveValue(UNRELATED_DRAFT);
  expect((await fixture.shelf()).selectedId).toBe(SELECTED_DRAFT);
  expect(fixture.unexpected).toEqual([]);
});

test("a physical queue cancellation double-click does not cancel the next request", async ({ page, feedbackOrigin }) => {
  const fixture = await mountFeedback(page, feedbackOrigin);
  await failedRequest(page).getByRole("button", { name: "Retry", exact: true }).click();
  const queue = page.getByRole("region", { name: "Queued requests" });
  await expect(queue.getByRole("button", { name: "Cancel request" })).toHaveCount(2);
  await queue.getByRole("button", { name: "Cancel request" }).first().dblclick({ delay: 80 });
  await expect.poll(() => fixture.mutations.length).toBeGreaterThan(0);
  await expect(queue).not.toContainText(QUEUED_TASK);
  await expect(queue).toContainText(ORIGINAL_MR_TASK);
  expect(fixture.mutations).toHaveLength(1);
  expect(fixture.mutations[0]).toMatchObject({ conversationId: ACTIVE_CONVERSATION, messageId: QUEUED_MESSAGE, action: "cancel" });
  expect(fixture.sends).toHaveLength(1);
  await expect(page.getByRole("textbox", { name: "Message to agent" })).toHaveValue(UNRELATED_DRAFT);
  expect(fixture.unexpected).toEqual([]);
});
