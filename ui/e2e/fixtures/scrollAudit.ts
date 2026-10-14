import { expect, type Page } from "@playwright/test";

export interface TrappedContent { element: string; clip: string; overflowPx: number }

/**
 * Finds visible content that the user cannot scroll to. Content is trapped when it extends past
 * the nearest ancestor that clips it and that ancestor cannot scroll on that axis.
 */
export async function findTrappedContent(page: Page): Promise<TrappedContent[]> {
  return page.evaluate(() => {
    const describe = (element: Element) => {
      const ui = element.getAttribute("data-ui");
      const testId = element.getAttribute("data-testid");
      const label = element.getAttribute("aria-label");
      const classes = typeof element.className === "string" ? element.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
      return `${element.tagName.toLowerCase()}${ui ? `[data-ui=${ui}]` : ""}${testId ? `[data-testid=${testId}]` : ""}${label ? `[aria-label="${label.slice(0, 40)}"]` : ""}${classes ? `.${classes}` : ""}`;
    };
    const clips = (value: string) => value === "hidden" || value === "clip";
    const scrolls = (value: string) => value === "auto" || value === "scroll" || value === "overlay";
    const viewport = { top: 0, bottom: window.innerHeight };
    const root = document.scrollingElement as HTMLElement;
    const rootStyle = getComputedStyle(root);
    const bodyStyle = getComputedStyle(document.body);
    const documentScrolls = !clips(rootStyle.overflowY) && !clips(bodyStyle.overflowY);
    const found = new Map<string, { element: string; clip: string; overflowPx: number }>();
    for (const element of document.body.querySelectorAll<HTMLElement>("*")) {
      if (element.closest("[aria-hidden='true'], [hidden], [inert], details:not([open]) > :not(summary)")) continue;
      const style = getComputedStyle(element);
      if (style.visibility !== "visible" || style.display === "contents" || style.position === "fixed") continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      if (!element.childElementCount && !element.textContent?.trim() && !element.matches("button, input, textarea, select, img, svg, canvas, [role]")) continue;
      let ancestor = element.parentElement;
      let clipped: { box: { top: number; bottom: number }; name: string } | null = null;
      while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
        const overflowY = getComputedStyle(ancestor).overflowY;
        if (scrolls(overflowY)) break;
        if (clips(overflowY)) { const box = ancestor.getBoundingClientRect(); clipped = { box, name: describe(ancestor) }; break; }
        ancestor = ancestor.parentElement;
      }
      if (!clipped && (!ancestor || ancestor === document.body || ancestor === document.documentElement) && !documentScrolls) {
        clipped = { box: viewport, name: "document" };
      }
      if (!clipped) continue;
      const below = rect.bottom - (clipped.name === "document" ? viewport.bottom : clipped.box.bottom);
      if (below <= 2 || rect.top >= clipped.box.bottom) continue;
      const key = `${clipped.name}::${describe(element)}`;
      if (!found.has(key)) found.set(key, { element: describe(element), clip: clipped.name, overflowPx: Math.round(below) });
    }
    return [...found.values()];
  });
}

/** Scroll containers that hold more content than they show must move when the user scrolls. */
export async function findStuckScrollers(page: Page): Promise<string[]> {
  const candidates = await page.evaluate(() => {
    const scrolls = (value: string) => value === "auto" || value === "scroll" || value === "overlay";
    return [...document.body.querySelectorAll<HTMLElement>("*")].flatMap((element, index) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (!scrolls(style.overflowY) || element.scrollHeight - element.clientHeight < 24) return [];
      if (rect.height < 40 || rect.bottom <= 0 || rect.top >= window.innerHeight || element.closest("[aria-hidden='true'], [hidden]")) return [];
      element.setAttribute("data-scroll-audit", String(index));
      const top = Math.max(rect.top, 0);
      const bottom = Math.min(rect.bottom, window.innerHeight);
      return [{ id: String(index), x: rect.left + rect.width / 2, y: top + (bottom - top) / 2, name: element.getAttribute("data-ui") ?? element.getAttribute("data-testid") ?? element.className }];
    });
  });
  const stuck: string[] = [];
  for (const candidate of candidates) {
    const scroller = page.locator(`[data-scroll-audit="${candidate.id}"]`);
    // A nested scroller under the pointer can take the wheel first. Any movement in the subtree counts.
    const offsets = () => scroller.evaluate((element) => [element, ...element.querySelectorAll("*")].map((node) => node.scrollTop).join(","));
    const before = await offsets();
    await page.mouse.move(candidate.x, candidate.y);
    await page.mouse.wheel(0, 240);
    await expect.poll(offsets, { timeout: 1500 }).not.toBe(before).catch(() => stuck.push(String(candidate.name)));
    await scroller.evaluate((element) => { for (const node of [element, ...element.querySelectorAll("*")]) node.scrollTop = 0; });
  }
  return stuck;
}

export async function expectScrollable(page: Page, screen: string) {
  const trapped = await findTrappedContent(page);
  expect(trapped, `${screen}: content past a clipping container that cannot scroll`).toEqual([]);
  const stuck = await findStuckScrollers(page);
  expect(stuck, `${screen}: scroll containers that do not move on a wheel scroll`).toEqual([]);
}
