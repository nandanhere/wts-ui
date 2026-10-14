import { ORDERS, expect, mountProduct, saveEvidence, screenshot, test } from "./fixtures/productPolish";

// The app sections sit flush in the top bar. The current section shows an underline on the bar edge, not a raised pill.
test("the app sections sit flush in the top bar and underline the current section", async ({ page, productOrigin }, testInfo) => {
  const fixture = await mountProduct(page, productOrigin, { theme: "dark", path: `/sessions/${ORDERS}` });
  try {
    const nav = page.getByRole("navigation", { name: "App sections" });
    await expect(nav).toBeVisible();
    const bar = page.locator('[data-ui="wts.top-bar"]');
    const transparent = (value: string) => value === "transparent" || value === "rgba(0, 0, 0, 0)";

    const navStyle = await nav.evaluate((node) => {
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, radius: style.borderTopLeftRadius, top: style.borderTopWidth };
    });
    expect(transparent(navStyle.background), "The section group has no box fill.").toBe(true);
    expect(navStyle.top, "The section group has no outline box.").toBe("0px");

    const current = nav.locator('button[aria-current="page"]');
    await expect(current).toHaveCount(1);
    const currentStyle = await current.evaluate((node) => {
      const style = getComputedStyle(node);
      const line = getComputedStyle(node, "::after");
      return { background: style.backgroundColor, shadow: style.boxShadow, line: line.backgroundColor, lineHeight: line.height };
    });
    expect(transparent(currentStyle.background), "The current section is not a raised pill.").toBe(true);
    expect(currentStyle.shadow).toBe("none");
    expect(transparent(currentStyle.line), "The current section shows an underline.").toBe(false);
    expect(currentStyle.lineHeight).toBe("2px");

    const barBox = (await bar.boundingBox())!;
    const tabBox = (await current.boundingBox())!;
    expect(Math.abs(tabBox.y + tabBox.height - (barBox.y + barBox.height)), "The section tab reaches the bottom edge of the top bar.").toBeLessThanOrEqual(2);

    const idle = nav.locator('button:not([aria-current])').first();
    expect(transparent(await idle.evaluate((node) => getComputedStyle(node, "::after").backgroundColor))).toBe(true);
    await screenshot(page, testInfo, "app-navigation");
    expect(fixture.errors).toEqual([]);
  } finally {
    await saveEvidence(page, testInfo, fixture);
  }
});
