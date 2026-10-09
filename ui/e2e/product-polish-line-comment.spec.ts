import { ORDERS, expect, mountProduct, saveEvidence, screenshot, test } from "./fixtures/productPolish";

// The line comment button must sit in the gutter next to the line number. It must not cover the number.
test("the line comment button does not cover the line number", async ({ page, productOrigin }, testInfo) => {
  const fixture = await mountProduct(page, productOrigin, { theme: "dark", path: `/sessions/${ORDERS}` });
  try {
    await page.getByRole("tab", { name: /^(Changes|Code review)/ }).click();
    const comparison = page.getByRole("combobox", { name: "Code comparison" });
    await comparison.click();
    await page.getByRole("option", { name: /Published MR/ }).click();
    await expect(comparison).toContainText("Published MR");
    const token = page.getByText("captureOnce", { exact: true }).first();
    await expect(token).toBeVisible();
    const box = (await token.boundingBox())!;
    await page.mouse.move(box.x + 4, box.y + box.height / 2, { steps: 4 });
    await page.mouse.move(box.x + 12, box.y + box.height / 2, { steps: 4 });
    const button = page.getByRole("button", { name: /^Comment on/ });
    await expect(button).toBeVisible();
    const boxes = await button.evaluate((element) => {
      const wrapper = element.closest('[slot="gutter-utility-slot"]');
      const cell = wrapper?.assignedSlot?.closest("[data-column-number]");
      const number = cell?.querySelector("[data-line-number-content]");
      const rect = (node: Element | null | undefined) => { if (!node) return null; const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      const range = document.createRange();
      if (number?.firstChild) range.selectNodeContents(number);
      const text = number?.firstChild ? range.getBoundingClientRect() : null;
      return { button: rect(element), cell: rect(cell), number: text && { left: text.left, right: text.right, top: text.top, bottom: text.bottom } };
    });
    expect(boxes.cell, "The button sits in a line number cell.").not.toBeNull();
    expect(boxes.number, "The line number has text.").not.toBeNull();
    expect(boxes.button!.right, "The button ends before the line number starts.").toBeLessThanOrEqual(boxes.number!.left);
    expect(boxes.button!.left, "The button stays inside the gutter.").toBeGreaterThanOrEqual(boxes.cell!.left);
    expect(boxes.button!.bottom - boxes.button!.top, "The button fits in one line.").toBeLessThanOrEqual(boxes.cell!.bottom - boxes.cell!.top);
    await screenshot(page, testInfo, "line-comment-button");
    expect(fixture.errors).toEqual([]);
  } finally {
    await saveEvidence(page, testInfo, fixture);
  }
});
