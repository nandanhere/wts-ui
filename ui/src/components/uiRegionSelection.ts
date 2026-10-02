export const UI_REGION_SELECTED_EVENT = "wts:ui-region-selected";

export interface UiRegionSelection {
  schemaVersion: 1;
  id: string;
  label: string;
  route: string;
  capturedAtUnixMs: number;
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number; devicePixelRatio: number };
  visibleText: string;
  captureAllowed?: boolean;
  ancestors: Array<{ id: string; label: string }>;
  controls: Array<{
    role: string;
    label: string;
    disabled: boolean;
    expanded?: boolean;
    selected?: boolean;
    checked?: boolean | "mixed";
  }>;
}

declare global {
  interface WindowEventMap {
    "wts:ui-region-selected": CustomEvent<UiRegionSelection>;
  }
}

const editableSelector = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"]';
const excludedSelector = `[data-ui-context="exclude"], [data-ui-callout-overlay], script, style, noscript, ${editableSelector}`;

export function regionParent(element: Element): Element | null {
  return element.parentElement ?? (element.getRootNode() instanceof ShadowRoot
    ? (element.getRootNode() as ShadowRoot).host : null);
}

export function isRegionEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  let element: Element | null = target;
  while (element) {
    if (element.matches(editableSelector)) return true;
    element = regionParent(element);
  }
  return false;
}

export function isRegionExcluded(target: Element): boolean {
  for (let element: Element | null = target; element; element = regionParent(element)) {
    if (element.matches('[data-ui-context="exclude"], [data-ui-callout-overlay], [hidden], [inert], [aria-hidden="true"]')) return true;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return true;
  }
  return false;
}

function visibleRect(element: Element) {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
}

export function canCaptureUiRegion(rect: UiRegionSelection["rect"]): boolean {
  let visited = 0;
  const inspect = (element: Element, depth: number): boolean => {
    if (++visited > 8_000 || depth > 64) return false;
    if (element.matches("[hidden], [data-ui-callout-overlay], script, style, noscript")) return true;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return true;
    const bounds = element.getBoundingClientRect();
    const overlaps = bounds.width > 0 && bounds.height > 0 && bounds.right > rect.x && bounds.bottom > rect.y && bounds.left < rect.x + rect.width && bounds.top < rect.y + rect.height;
    if (overlaps && (element.matches(`${editableSelector}, [data-ui-context="exclude"], iframe, object, embed`) ||
      (element.localName.includes("-") && !element.shadowRoot))) return false;
    if (element.matches("details:not([open])")) {
      const summary = Array.from(element.children).find((child) => child.tagName === "SUMMARY");
      return !summary || inspect(summary, depth + 1);
    }
    // Inspect open shadow roots and siblings that overlap the crop. Unknown content blocks capture.
    const children = element.shadowRoot?.children ?? element.children;
    for (const child of children) if (!inspect(child, depth + 1)) return false;
    return true;
  };
  return inspect(document.documentElement, 0);
}

function captureContent(root: HTMLElement): Pick<UiRegionSelection, "visibleText" | "controls"> {
  const text: string[] = [];
  const controls: UiRegionSelection["controls"] = [];
  let textLength = 0;
  let visited = 0;
  const visit = (node: Node, depth: number) => {
    if (++visited > 4_000 || depth > 32 || textLength >= 6_000) return;
    if (node instanceof Element) {
      if (node.matches(excludedSelector) || isRegionExcluded(node) || !visibleRect(node)) return;
      const role = node.getAttribute("role") ?? (node.matches("button, summary") ? "button" : node.matches("a[href]") ? "link" : "");
      if (role && controls.length < 24) {
        // Field values and arbitrary data attributes are not context.
        const label = (node.getAttribute("aria-label") ?? Array.from(node.childNodes)
          .filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent).join(" "))
          .replace(/\s+/g, " ").trim().slice(0, 160);
        const control: UiRegionSelection["controls"][number] = {
          role: role.slice(0, 40), label,
          disabled: node.hasAttribute("disabled") || node.getAttribute("aria-disabled") === "true",
        };
        for (const name of ["expanded", "selected", "checked"] as const) {
          const value = node.getAttribute(`aria-${name}`);
          if (value === "true" || value === "false") control[name] = value === "true";
          else if (name === "checked" && value === "mixed") control.checked = "mixed";
        }
        controls.push(control);
      }
      if (node.matches("details:not([open])")) {
        const summary = Array.from(node.children).find((child) => child.tagName === "SUMMARY");
        if (summary) visit(summary, depth + 1);
        return;
      }
      const children = node.shadowRoot?.childNodes ?? node.childNodes;
      for (const child of children) {
        visit(child, depth + 1);
        if (visited >= 4_000 || textLength >= 6_000) break;
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      const value = (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 6_000 - textLength);
      if (value) { text.push(value); textLength += value.length + 1; }
    }
  };
  visit(root, 0);
  return { visibleText: text.join(" ").slice(0, 6_000), controls };
}

export function captureUiRegion(element: HTMLElement): UiRegionSelection | null {
  const id = element.dataset.ui?.trim();
  const label = element.dataset.uiLabel?.trim();
  if (!id || !label || isRegionExcluded(element) || !visibleRect(element)) return null;
  const bounds = element.getBoundingClientRect();
  const x = Math.max(0, bounds.left);
  const y = Math.max(0, bounds.top);
  const rect = { x, y, width: Math.min(window.innerWidth, bounds.right) - x, height: Math.min(window.innerHeight, bounds.bottom) - y };
  const ancestors: UiRegionSelection["ancestors"] = [];
  for (let parent = regionParent(element); parent && ancestors.length < 6; parent = regionParent(parent)) {
    const parentId = parent.getAttribute("data-ui")?.trim();
    const parentLabel = parent.getAttribute("data-ui-label")?.trim();
    if (parentId && parentLabel) ancestors.push({ id: parentId.slice(0, 256), label: parentLabel.slice(0, 256) });
  }
  // Keep the known routing parameter. Do not capture tokens in arbitrary URLs.
  const routeParams = new URLSearchParams();
  const repository = new URLSearchParams(window.location.search).get("repository");
  if (repository) routeParams.set("repository", repository.slice(0, 256));
  const query = routeParams.toString();
  return {
    schemaVersion: 1, id: id.slice(0, 256), label: label.slice(0, 256),
    route: `${window.location.pathname}${query ? `?${query}` : ""}`.slice(0, 1_024),
    capturedAtUnixMs: Date.now(),
    rect, captureAllowed: canCaptureUiRegion(rect),
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 },
    ...captureContent(element), ancestors,
  };
}
