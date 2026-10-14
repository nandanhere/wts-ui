import { ORDERS, expect, mountProduct, saveEvidence, screenshot, test } from "./fixtures/productPolish";

// The Add repository dialog must show one box per field, and the Clone button must sit inside the URL field.
test("the add repository dialog fields have one box each and keep the Clone button inside", async ({ page, productOrigin }, testInfo) => {
  const fixture = await mountProduct(page, productOrigin, { theme: "dark", path: `/sessions/${ORDERS}` });
  try {
    await page.getByRole("button", { name: "Add repositories" }).first().click();
    const dialog = page.getByRole("dialog", { name: /^Add repository to/ });
    await expect(dialog).toBeVisible();
    const select = dialog.locator('[data-ui="workspace.add-repository-select"]');
    await expect(select).toBeVisible();
    const boxes = await select.evaluate((root) =>
      [root, ...root.querySelectorAll("*")].filter((node) => {
        const style = getComputedStyle(node);
        return parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== "none"
          && node.getBoundingClientRect().height >= 30;
      }).length);
    expect(boxes, "The repository picker draws one field box.").toBe(1);

    const field = dialog.locator('[data-ui="workspace.add-repository-url"]');
    const clone = field.getByRole("button", { name: /^Clon/ });
    const outer = (await field.boundingBox())!;
    const inner = (await clone.boundingBox())!;
    expect(inner.x + inner.width, "Clone ends inside the URL field.").toBeLessThanOrEqual(outer.x + outer.width);
    expect(inner.y, "Clone starts inside the URL field.").toBeGreaterThanOrEqual(outer.y);
    expect(inner.y + inner.height, "Clone ends inside the URL field.").toBeLessThanOrEqual(outer.y + outer.height);
    await screenshot(page, testInfo, "add-repository-dialog");
    expect(fixture.errors).toEqual([]);
  } finally {
    await saveEvidence(page, testInfo, fixture);
  }
});

