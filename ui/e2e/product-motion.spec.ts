import { expect, mountFeedback, test } from "./fixtures/agentFeedback";

test("reduced motion covers controls in feedback outside the workspace shell", async ({ page, feedbackOrigin }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fixture = await mountFeedback(page, feedbackOrigin);
  const provider = page.getByRole("combobox", { name: "Feedback agent" });
  await provider.scrollIntoViewIfNeeded();
  const transition = await provider.evaluate(element => getComputedStyle(element).transitionDuration
    .split(",").map(value => parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1_000)));
  expect(Math.max(...transition)).toBeLessThanOrEqual(1);
  await provider.click();
  await page.getByRole("option", { name: "OpenCode", exact: true }).click();
  await expect(provider).toContainText("OpenCode");
  await expect(provider).toBeFocused();
  expect(fixture.sends).toHaveLength(0);
  expect(fixture.unexpected).toEqual([]);
});

test("menu entry and exit fade without moving the selectable options", async ({ page, feedbackOrigin }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const fixture = await mountFeedback(page, feedbackOrigin);
  await page.evaluate(() => {
    const records: Array<{ frames: Array<{ transform?: string; opacity?: string | number }>; duration: number }> = [];
    (window as unknown as { menuMotion: typeof records }).menuMotion = records;
    document.addEventListener("animationstart", event => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.querySelector('[role="listbox"]')) return;
      for (const animation of target.getAnimations()) {
        if (!(animation.effect instanceof KeyframeEffect)) continue;
        const duration = animation.effect.getTiming().duration;
        records.push({ frames: animation.effect.getKeyframes().map(frame => ({ transform: frame.transform as string | undefined, opacity: frame.opacity as string | number | undefined })), duration: typeof duration === "number" ? duration : 0 });
      }
    });
  });
  const provider = page.getByRole("combobox", { name: "Feedback agent" });
  await provider.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { menuMotion: unknown[] }).menuMotion.length)).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(provider).toBeFocused();
  const animations = await page.evaluate(() => (window as unknown as { menuMotion: Array<{ frames: Array<{ transform?: string; opacity?: string | number }>; duration: number }> }).menuMotion);
  expect(animations.length).toBeGreaterThanOrEqual(2);
  for (const animation of animations) {
    expect(animation.duration).toBeGreaterThan(0);
    expect(animation.duration).toBeLessThanOrEqual(200);
    expect(animation.frames.some(frame => frame.opacity !== undefined)).toBe(true);
    expect(animation.frames.every(frame => !frame.transform || frame.transform === "none")).toBe(true);
  }
  expect(fixture.sends).toHaveLength(0);
  expect(fixture.unexpected).toEqual([]);
});
