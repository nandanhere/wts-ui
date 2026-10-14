/** Run with the supported browser tab and viewport handles. */
export async function verifyAgentLabLayout(tab, viewport) {
  const results = [];
  try {
    await tab.playwright.getByRole('button', {name:'Time & capacity', exact:true}).click();
    for (const width of [390, 1024, 1440]) {
      await viewport.set({width,height:900});
      const size = await tab.playwright.evaluate(() => ({viewport:innerWidth,document:document.documentElement.scrollWidth}));
      if (size.document > size.viewport) throw new Error(`Timeline overflows at ${width}px: ${size.document}px`);
      results.push({width,passed:true});
    }
    return results;
  } finally {
    await viewport.reset();
  }
}
