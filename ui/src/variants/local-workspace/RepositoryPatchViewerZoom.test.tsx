import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { RepositoryPatchViewer } from "./RepositoryPatchViewer";

const patch = [
  "diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md",
  "@@ -1 +1 @@", "-# Before", "+# After", "",
].join("\n");

function rendererStyles(container: HTMLElement) {
  return container.querySelector("diffs-container")?.shadowRoot
    ?.querySelector("[data-unsafe-css]")?.textContent;
}

describe("review text zoom", () => {
  beforeEach(() => localStorage.clear());

  it("scales the actual renderer with Command and Control shortcuts", async () => {
    const view = render(<RepositoryPatchViewer patch={patch} theme="dark" />);
    const code = screen.getByLabelText("Changed code text");
    fireEvent.pointerDown(code);
    expect(code).toHaveFocus();
    fireEvent.keyDown(code, { key: "+", metaKey: true, shiftKey: true });
    await waitFor(() => expect(rendererStyles(view.container)).toContain("--diffs-font-size: 14.3px"));
    expect(rendererStyles(view.container)).toContain("--diffs-line-height: 22px");
    fireEvent.keyDown(code, { key: "-", metaKey: true });
    await waitFor(() => expect(rendererStyles(view.container)).toContain("--diffs-font-size: 13px"));
    fireEvent.keyDown(code, { key: "=", ctrlKey: true });
    await waitFor(() => expect(rendererStyles(view.container)).toContain("--diffs-font-size: 14.3px"));
    fireEvent.keyDown(code, { key: "0", metaKey: true });
    await waitFor(() => expect(rendererStyles(view.container)).toContain("--diffs-line-height: 20px"));
  });

  it("leaves shortcuts outside the viewer and in text fields alone", () => {
    render(<RepositoryPatchViewer patch={patch} theme="dark" />);
    for (const target of [window, screen.getByRole("searchbox")]) {
      expect(fireEvent.keyDown(target, { key: "+", metaKey: true })).toBe(true);
    }
    const code = screen.getByLabelText("Changed code text");
    fireEvent.keyDown(code, { key: "+" });
    fireEvent.keyDown(code, { key: "+", metaKey: true, altKey: true });
    expect(screen.getByRole("button", { name: "Reset text size" })).toHaveTextContent("100%");
  });

  it("bounds button zoom, scales previews, and restores the saved size", async () => {
    const view = render(<RepositoryPatchViewer patch={patch} theme="dark" singleFile />);
    const increase = screen.getByRole("button", { name: "Increase text size" });
    for (let i = 0; i < 15; i++) fireEvent.click(increase);
    expect(increase).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Preview Markdown for README.md" }));
    expect(await screen.findByRole("heading", { name: "After" })).toBeVisible();
    expect(view.container.querySelector('[data-ui="changes.viewer"]')).toHaveStyle({ "--review-text-size": "28px" });
    view.unmount();
    render(<RepositoryPatchViewer patch={patch} theme="dark" singleFile />);
    expect(screen.getByRole("button", { name: "Reset text size" })).toHaveTextContent("200%");
    const decrease = screen.getByRole("button", { name: "Decrease text size" });
    for (let i = 0; i < 20; i++) fireEvent.click(decrease);
    expect(decrease).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset text size" })).toHaveTextContent("70%");
    fireEvent.click(screen.getByRole("button", { name: "Reset text size" }));
    expect(screen.getByRole("button", { name: "Reset text size" })).toHaveTextContent("100%");
  });
});
