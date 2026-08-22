import { describe, expect, it } from "vitest";
import {
  applyResolvedTheme,
  loadThemePreference,
  normalizeThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
} from "./theme";
import "./global.css";

describe("theme contract", () => {
  it("fails closed to the system preference for malformed persisted values", () => {
    expect(normalizeThemePreference("midnight")).toBe("system");
    expect(
      loadThemePreference({
        getItem: (key) => (key === THEME_STORAGE_KEY ? "midnight" : null),
      }),
    ).toBe("system");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("applies the resolved theme to both document chrome boundaries", () => {
    const root = document.documentElement;
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.append(meta);

    applyResolvedTheme("dark");

    expect(root).toHaveAttribute("data-theme", "dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(meta).toHaveAttribute("content", "#0f141c");
    expect(
      getComputedStyle(root).getPropertyValue("--wts-canvas").trim(),
    ).toBe("#0f141c");
    expect(
      getComputedStyle(root).getPropertyValue("--wts-surface").trim(),
    ).toBe("#151b24");
    expect(
      getComputedStyle(root).getPropertyValue("--wts-shadow-md").trim(),
    ).toContain("rgba(255, 255, 255");
    expect(
      getComputedStyle(root).getPropertyValue("--wts-control-height").trim(),
    ).toBe("44px");

    applyResolvedTheme("light");
    meta.remove();
  });
});
