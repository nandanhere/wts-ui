import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RepositoryPatchViewer } from "./RepositoryPatchViewer";

const patch = (before: number, after: number) => [
  "diff --git a/src/retry.ts b/src/retry.ts",
  `index ${String(before).repeat(7)}..${String(after).repeat(7)} 100644`,
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -1 +1 @@",
  `-export const retryLimit = ${before};`,
  `+export const retryLimit = ${after};`,
  "",
].join("\n");

function renderedCode(container: HTMLElement) {
  return Array.from(container.querySelectorAll("diffs-container"))
    .map((element) => element.shadowRoot?.textContent ?? "")
    .join("\n");
}

describe("repository patch renderer", () => {
  it.each([true, false])("uses one working file heading and WTS surfaces in the actual renderer (singleFile=%s)", async (singleFile) => {
    const view = render(<RepositoryPatchViewer patch={patch(1, 5)} theme="dark" singleFile={singleFile} />);
    await waitFor(() => expect(renderedCode(view.container)).toContain("retryLimit = 1;"));
    const shadow = view.container.querySelector("diffs-container")!.shadowRoot!;
    expect(shadow.querySelector("[data-diffs-header]")).toBeNull();
    expect(shadow.querySelector("[data-unsafe-css]")?.textContent).toContain("--diffs-bg: var(--wts-surface)");
    const heading = view.container.querySelector('button[aria-controls^="diff-body-"]')!;
    expect(heading).toHaveTextContent("src/retry.ts");
    fireEvent.click(heading);
    expect(view.container.querySelector("diffs-container")).toBeNull();
    fireEvent.click(heading);
    await waitFor(() => expect(renderedCode(view.container)).toContain("retryLimit = 1;"));
  });

  it("updates the actual diff when the same file gets a different comparison", async () => {
    const view = render(<RepositoryPatchViewer patch={patch(1, 5)} theme="dark" />);
    await waitFor(() => expect(renderedCode(view.container)).toContain("retryLimit = 1;"));
    view.rerender(<RepositoryPatchViewer patch={patch(3, 5)} theme="dark" />);
    await waitFor(() => expect(renderedCode(view.container)).toContain("retryLimit = 3;"));
    expect(renderedCode(view.container)).not.toContain("retryLimit = 1;");
    view.rerender(<RepositoryPatchViewer patch={patch(3, 7)} theme="dark" />);
    await waitFor(() => expect(renderedCode(view.container)).toContain("retryLimit = 7;"));
    expect(renderedCode(view.container)).not.toContain("retryLimit = 5;");
  });
});
