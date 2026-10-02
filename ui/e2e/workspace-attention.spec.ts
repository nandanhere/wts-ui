import { writeFile } from "node:fs/promises";
import { expect, test } from "./fixtures/productPolish";
import { DRAFT_TEXT, ids, mountAttention, titles } from "./fixtures/workspaceAttention";

for (const width of [1440, 375]) for (const theme of ["light", "dark"] as const) {
  test(`five-workspace attention in ${theme} at ${width}px`, async ({ page, productOrigin }, testInfo) => {
    await page.setViewportSize({ width, height: width === 375 ? 640 : 900 });
    const fixture = await mountAttention(page, productOrigin, theme);
    const card = (index: number) => page.getByRole("region", { name: `ATTN-${101 + index} attention`, exact: true });
    const result = (index: number) => card(index).getByRole("button", { name: `${titles[index]} Agent result awaits review.`, exact: true });
    await expect(page.locator('[data-ui="spaces.attention-summary"]')).toContainText("3 agent results · 1 failed check · 2 unread comments");
    for (let index = 0; index < 5; index++) await expect(card(index)).toBeAttached();
    await expect(result(0)).toBeVisible();
    await expect(card(2).getByRole("button", { name: "Checkout unit tests The check failed.", exact: true })).toBeVisible();
    await expect(card(3).getByRole("button", { name: /src\/capture.ts Unread comments and replies/ })).toBeVisible();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath(`attention-${theme}-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const toolbarGeometry = await page.locator('[data-ui="spaces.toolbar"]').evaluate(element => [...element.querySelectorAll("button")].map(button => {
      const bounds = button.getBoundingClientRect();
      return { label: button.getAttribute("aria-label") ?? button.textContent, x: bounds.x, right: bounds.right, width: bounds.width };
    }));
    for (const button of toolbarGeometry) {
      expect(button.x, `${button.label} starts inside the viewport`).toBeGreaterThanOrEqual(0);
      expect(button.right, `${button.label} ends inside the viewport`).toBeLessThanOrEqual(width);
    }
    if (width === 375) {
      const thread = card(3).getByRole("button", { name: /src\/capture.ts Unread comments and replies/ });
      await thread.focus();
      await expect(thread).toBeFocused();
      await expect(thread).toBeInViewport();
      const bounds = await thread.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      await page.screenshot({ animations: "disabled", path: testInfo.outputPath(`attention-${theme}-${width}-mr.png`) });
    }

    if (width === 1440 && theme === "light") {
      await result(0).click();
      const reply = page.getByText(`Exact saved result: ${titles[0]}. The local changes are ready for review.`, { exact: true });
      await expect(reply).toBeVisible();
      await expect(reply.locator("xpath=ancestor::article")).toBeFocused();
      await expect(page.getByRole("textbox", { name: "Message to agent" })).toHaveValue(DRAFT_TEXT);
      await page.getByRole("button", { name: "Close agent feedback", exact: true }).click();
      await expect(result(0)).toBeVisible();
      await card(0).getByRole("button", { name: `Mark ${titles[0]} as reviewed`, exact: true }).click();
      await expect(result(0)).toHaveCount(0);
      await expect(card(0).getByText("History (1)", { exact: true })).toBeVisible();

      await card(2).getByRole("button", { name: "Checkout unit tests The check failed.", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/sessions/${ids[2]}/verification$`));
      await expect(page.getByRole("region", { name: "Selected check result" })).toContainText("Expected one capture, received two.");
      await page.getByRole("button", { name: "Open Spaces", exact: true }).click();

      await card(3).getByRole("button", { name: /src\/capture.ts Unread comments and replies/ }).click();
      await expect(page).toHaveURL(new RegExp(`/sessions/${ids[3]}/changes`));
      await expect(page.getByRole("button", { name: "src/capture.ts:+2 by @priya", exact: true })).toBeFocused();
      await expect(page.getByRole("textbox", { name: "Reply", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Open Spaces", exact: true }).click();
      await expect(card(3).getByRole("button", { name: /src\/capture.ts Unread comments and replies/ })).toHaveCount(0);
      await expect(card(3).getByRole("button", { name: /tests\/capture.test.ts Unread comments and replies/ })).toBeVisible();
      await expect(card(3).getByText("History (1)", { exact: true })).toBeVisible();

      fixture.offline(true);
      await page.getByRole("button", { name: "Refresh review status", exact: true }).click();
      await expect(card(3)).toContainText("GitLab status is unavailable. Saved items remain visible.");
      await expect(card(3).getByRole("button", { name: /tests\/capture.test.ts Unread comments and replies/ })).toBeVisible();
      fixture.offline(false); fixture.passCheck();
      await card(3).getByRole("button", { name: "Retry status", exact: true }).click();
      await expect(card(3).getByRole("button", { name: "Retry status", exact: true })).toHaveCount(0);
      await expect(card(2).getByRole("button", { name: "Checkout unit tests The check failed.", exact: true })).toHaveCount(0);
      await expect(card(2).getByText("History (1)", { exact: true })).toBeVisible();
      await expect(result(0)).toHaveCount(0);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem("wts.agent-feedback.shelf.v2")!).drafts[0].body)).toBe(DRAFT_TEXT);
    }
    expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]); expect(fixture.writes).toEqual([]);
    await writeFile(testInfo.outputPath("attention-evidence.json"), JSON.stringify({ conditions: "Full App and real attention store, isolated serialized HTTP fixtures, no provider writes.", toolbarGeometry, ...fixture }, null, 2));
  });
}
