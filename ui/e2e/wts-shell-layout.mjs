/** Run with the supported browser-control tab and browser handles. */
export async function checkWtsShellLayout(tab, browser) {
  const viewport = await browser.capabilities.get("viewport");
  const results = [];
  try {
    for (const width of [390, 900, 1440]) {
      await viewport.set({ width, height: 780 });
      const result = await tab.playwright.evaluate(() => {
        const nav = document.querySelector('[data-ui="wts.navigation"]');
        const controls = document.querySelector('[data-ui="wts.controls"]');
        if (!nav || !controls) throw new Error("The shell navigation is missing.");
        const n = nav.getBoundingClientRect();
        const c = controls.getBoundingClientRect();
        return {
          width: window.innerWidth,
          overflow: document.documentElement.scrollWidth > window.innerWidth,
          overlap: n.left < c.right && n.right > c.left && n.top < c.bottom && n.bottom > c.top,
          buttons: Array.from(nav.querySelectorAll("button")).map(button => {
            const r = button.getBoundingClientRect();
            return { label: button.textContent, visible: r.left >= 0 && r.right <= window.innerWidth && r.height >= 30 };
          }),
        };
      });
      if (result.overflow || result.overlap || result.buttons.length !== 4 || result.buttons.some(button => !button.visible)) {
        throw new Error("Shell layout failed: " + JSON.stringify(result));
      }
      results.push(result);
    }
    return results;
  } finally {
    await viewport.reset();
  }
}
