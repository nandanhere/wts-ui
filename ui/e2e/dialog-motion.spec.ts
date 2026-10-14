import { expect, mountProduct, test } from "./fixtures/productPolish";

for (const [triggerName, dialogName] of [
  ["New workspace", "New workspace"],
  ["Open Environment and integrations", "Environment & integrations"],
  ["Open command palette", "Commands"],
  ["Open How to use WTS", "How to use WTS"],
] as const) {
  test(`${dialogName} fades at a fixed position and returns keyboard focus`, async ({ page, productOrigin }, testInfo) => {
    const fixture = await mountProduct(page, productOrigin);
    await page.evaluate(() => {
      const records: Array<{ state: string | null; duration: number; transforms: Array<string | undefined> }> = [];
      Object.assign(window, { dialogMotion: records });
      const focus: string[] = [];
      Object.assign(window, { dialogFocus: focus });
      document.addEventListener("focusin", event => {
        const element = event.target as HTMLElement;
        focus.push(element.getAttribute("aria-label") ?? element.textContent?.slice(0, 80) ?? element.tagName);
      });
      document.addEventListener("animationstart", event => {
        const target = event.target;
        if (!(target instanceof HTMLElement) || target.getAttribute("role") !== "dialog") return;
        for (const animation of target.getAnimations()) {
          if (!(animation.effect instanceof KeyframeEffect)) continue;
          records.push({ state: target.getAttribute("data-state"), duration: Number(animation.effect.getTiming().duration), transforms: animation.effect.getKeyframes().map(frame => frame.transform as string | undefined) });
        }
      });
    });
    const trigger = page.getByRole("button", { name: triggerName, exact: true });
    await trigger.click();
    await expect(page.getByRole("dialog", { name: dialogName, exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { dialogMotion: unknown[] }).dialogMotion.length)).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: dialogName, exact: true })).toHaveCount(0);
    await testInfo.attach("dialog-focus.json", { contentType: "application/json", body: JSON.stringify(await page.evaluate(() => ({ focus: (window as unknown as { dialogFocus: string[] }).dialogFocus, active: document.activeElement?.outerHTML.slice(0, 400) }))) });
    await expect(trigger).toBeFocused();
    const records = await page.evaluate(() => (window as unknown as { dialogMotion: Array<{ state: string | null; duration: number; transforms: Array<string | undefined> }> }).dialogMotion);
    expect(records.map(record => record.state)).toEqual(["open", "closed"]);
    for (const record of records) {
      expect(record.duration).toBeGreaterThan(0);
      expect(record.duration).toBeLessThanOrEqual(200);
      expect(record.transforms.every(transform => transform === undefined || transform === "none")).toBe(true);
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: dialogName, exact: true });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(element => parseFloat(getComputedStyle(element).animationDuration))).toBeLessThanOrEqual(.001);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}
