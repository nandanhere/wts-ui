import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

Object.defineProperty(Element.prototype, "scrollIntoView", {
  writable: true,
  value: vi.fn(),
});

Object.defineProperty(Element.prototype, "scrollTo", {
  configurable: true,
  writable: true,
  value: vi.fn(),
});

// ProseMirror measures text ranges and points. jsdom has no layout for them.
const emptyRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) });
for (const prototype of [Range.prototype, Element.prototype]) {
  if (!("getClientRects" in prototype) || prototype === Range.prototype) {
    Object.defineProperty(prototype, "getClientRects", {
      configurable: true,
      writable: true,
      value: function getClientRects() { return Object.assign([], { item: () => null }); },
    });
  }
}
if (!("getBoundingClientRect" in Range.prototype)) {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, writable: true, value: emptyRect });
}
if (!("elementFromPoint" in Document.prototype) || typeof document.elementFromPoint !== "function") {
  Object.defineProperty(Document.prototype, "elementFromPoint", { configurable: true, writable: true, value: () => null });
}

// jsdom exposes constructable style sheets without the browser replacement API.
Object.defineProperty(CSSStyleSheet.prototype, "replaceSync", {
  configurable: true,
  value: vi.fn(),
});

Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
  writable: true,
  value: vi.fn(() => false),
});

Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
  writable: true,
  value: vi.fn(),
});

Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
  writable: true,
  value: vi.fn(),
});

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class TestIntersectionObserver {
  root = null;
  rootMargin = "";
  thresholds = [];
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

Object.defineProperty(globalThis, "ResizeObserver", {
  writable: true,
  value: TestResizeObserver,
});

Object.defineProperty(globalThis, "IntersectionObserver", {
  writable: true,
  value: TestIntersectionObserver,
});
