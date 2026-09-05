import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import type { WorkspaceClient } from "../../lib/wtsClient";
import {
  adjacentChangeIndex,
  findChangedReferences,
  findGraphReferenceFiles,
  findGraphTestFiles,
  findPatchSearchMatches,
  isTestFile,
  loadReviewLayoutWidths,
  relatedTestFiles,
  summarizeRepositoryPatch,
  RepositoryPatchViewer,
  patchSearchNavigation,
  patchChangeTargets,
  patchTokenReferenceAction,
  selectedChangedPatchLine,
} from "./RepositoryPatchViewer";

const patchViewerStylesheet = readFileSync(
  resolve("src/variants/local-workspace/RepositoryPatchViewer.module.css"),
  "utf8",
);

function cssBlock(stylesheet: string, selector: string) {
  const selectorIndex = stylesheet.indexOf(selector);
  expect(selectorIndex, `Missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(0);
  const openingBrace = stylesheet.indexOf("{", selectorIndex);
  expect(openingBrace, `Missing CSS block: ${selector}`).toBeGreaterThan(selectorIndex);
  let depth = 0;
  for (let index = openingBrace; index < stylesheet.length; index += 1) {
    if (stylesheet[index] === "{") depth += 1;
    if (stylesheet[index] === "}") depth -= 1;
    if (depth === 0) return stylesheet.slice(openingBrace + 1, index);
  }
  throw new Error(`Unclosed CSS block: ${selector}`);
}

const patch =
  "diff --git a/src/checkout.ts b/src/checkout.ts\nindex 1111111..2222222 100644\n--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@ -1 +1 @@\n-export const checkout = false\n+export const checkout = true\ndiff --git a/src/checkout.test.ts b/src/checkout.test.ts\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/src/checkout.test.ts\n@@ -0,0 +1 @@\n+expect(checkout).toBe(true)\n";

const multiFilePatch = `
diff --git a/src/file1.ts b/src/file1.ts
index 1111111..2222222 100644
--- a/src/file1.ts
+++ b/src/file1.ts
@@ -1 +1 @@
-const a = 1;
+const a = 2;
diff --git a/src/file2.ts b/src/file2.ts
index 1111111..2222222 100644
--- a/src/file2.ts
+++ b/src/file2.ts
@@ -1 +1 @@
-const b = 1;
+const b = 2;
diff --git a/src/file3.ts b/src/file3.ts
index 1111111..2222222 100644
--- a/src/file3.ts
+++ b/src/file3.ts
@@ -1 +1 @@
-const c = 1;
+const c = 2;
diff --git a/src/file4.ts b/src/file4.ts
index 1111111..2222222 100644
--- a/src/file4.ts
+++ b/src/file4.ts
@@ -1 +1 @@
-const d = 1;
+const d = 2;
diff --git a/src/file5.ts b/src/file5.ts
index 1111111..2222222 100644
--- a/src/file5.ts
+++ b/src/file5.ts
@@ -1 +1 @@
-const e = 1;
+const e = 2;
`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function feedback(
  client: WorkspaceClient,
  overrides: Partial<NonNullable<Parameters<typeof RepositoryPatchViewer>[0]["feedback"]>> = {},
) {
  return {
    baseCommitOid: "0123456789abcdef0123456789abcdef01234567",
    client,
    headCommitOid: "fedcba9876543210fedcba9876543210fedcba98",
    patchSha256: `sha256:${"a".repeat(64)}`,
    repositoryId: "repo-checkout",
    workspaceId: "workspace-checkout",
    ...overrides,
  };
}

describe("repository review intelligence", () => {
  it("moves to exact adjacent changes and wraps at both ends", () => {
    expect(adjacentChangeIndex(-1, 5, "next")).toBe(0);
    expect(adjacentChangeIndex(-1, 5, "previous")).toBe(4);
    expect(adjacentChangeIndex(4, 5, "next")).toBe(0);
    expect(adjacentChangeIndex(0, 5, "previous")).toBe(4);
    expect(adjacentChangeIndex(2, 5, "next")).toBe(3);
    expect(adjacentChangeIndex(2, 0, "next")).toBe(-1);
  });

  it("separates production files from common test naming conventions", () => {
    expect(isTestFile("src/checkout.ts")).toBe(false);
    expect(isTestFile("src/checkout.test.ts")).toBe(true);
    expect(isTestFile("internal/apis/poll_machine_test.go")).toBe(true);
    expect(isTestFile("src/__tests__/checkout.ts")).toBe(true);
  });

  it("finds related changed tests and exact changed symbol references", () => {
    const summary = summarizeRepositoryPatch(patch);
    const source = summary.files.find(
      (file) => file.fileDiff.name === "src/checkout.ts",
    );

    expect(source).toBeDefined();
    expect(
      relatedTestFiles(summary.files, source!.fileDiff.name).map(
        (file) => file.fileDiff.name,
      ),
    ).toEqual(["src/checkout.test.ts"]);
    expect(findChangedReferences(summary.files, "checkout")).toEqual([
      expect.objectContaining({ fileName: "src/checkout.ts", matches: 2 }),
      expect.objectContaining({ fileName: "src/checkout.test.ts", matches: 1 }),
    ]);
  });

  it("maps every diff hunk to a stable change target", () => {
    const summary = summarizeRepositoryPatch(patch);
    expect(patchChangeTargets(summary.files)).toEqual([
      expect.objectContaining({
        fileName: "src/checkout.ts",
        hunkIndex: 0,
        lineNumber: 1,
        side: "additions",
      }),
      expect.objectContaining({
        fileName: "src/checkout.test.ts",
        hunkIndex: 0,
        lineNumber: 1,
        side: "additions",
      }),
    ]);
  });

  it("accepts only an added or deleted line as a feedback anchor", () => {
    const summary = summarizeRepositoryPatch(patch);
    const file = summary.files[0];
    expect(
      selectedChangedPatchLine(summary.files, {
        id: file.id,
        range: { start: 1, side: "additions" },
      }),
    ).toEqual({
      fileId: file.id,
      filePath: "src/checkout.ts",
      line: 1,
      side: "additions",
    });
    expect(
      selectedChangedPatchLine(summary.files, {
        id: file.id,
        range: { start: 2, side: "additions" },
      }),
    ).toBeUndefined();
    expect(
      selectedChangedPatchLine(summary.files, {
        id: file.id,
        range: { start: 1 },
      }),
    ).toBeUndefined();
  });

  it("excludes hunk context from feedback, navigation, and change totals", () => {
    const contextPatch = `diff --git a/src/context.ts b/src/context.ts
index 1111111..2222222 100644
--- a/src/context.ts
+++ b/src/context.ts
@@ -10,4 +10,4 @@
 export const before = true;
-export const changed = false;
+export const changed = true;
 export const after = true;
 export const last = true;
`;
    const summary = summarizeRepositoryPatch(contextPatch);
    const file = summary.files[0];

    expect(summary).toMatchObject({ additions: 1, deletions: 1 });
    expect(patchChangeTargets(summary.files)).toEqual([
      expect.objectContaining({
        fileName: "src/context.ts",
        lineNumber: 11,
        side: "additions",
      }),
    ]);
    expect(
      selectedChangedPatchLine(summary.files, {
        id: file.id,
        range: { start: 10, side: "additions" },
      }),
    ).toBeUndefined();
    expect(
      selectedChangedPatchLine(summary.files, {
        id: file.id,
        range: { start: 11, side: "additions" },
      }),
    ).toMatchObject({
      filePath: "src/context.ts",
      line: 11,
      side: "additions",
    });
  });

  it("uses bounded Graphify relationships for references and tests outside the patch", () => {
    const graph = {
      graphSha256: "sha256:review",
      truncated: false,
      nodes: [
        { id: "source", label: "checkout", sourceFile: "src/checkout.ts", sourceLocation: "L4" },
        { id: "caller", label: "checkout", sourceFile: "src/cart.ts", sourceLocation: "L19" },
        { id: "test", label: "checkout works", sourceFile: "tests/checkout.spec.ts", sourceLocation: "L8" },
      ],
      links: [
        { source: "source", target: "caller", relation: "calls", confidence: "EXTRACTED" },
        { source: "source", target: "test", relation: "tested_by", confidence: "INFERRED" },
      ],
    };

    expect(findGraphReferenceFiles(graph, "checkout")).toEqual([
      "src/cart.ts",
      "src/checkout.ts",
      "tests/checkout.spec.ts",
    ]);
    expect(findGraphTestFiles(graph, "src/checkout.ts")).toEqual([
      "tests/checkout.spec.ts",
    ]);
  });
});

describe("responsive review toolbar", () => {
  it("uses two bounded rows at phone widths without hiding search or change navigation", () => {
    const phone = cssBlock(patchViewerStylesheet, "@media (max-width: 520px)");
    const toolbar = cssBlock(phone, ".toolbar");
    const navigator = cssBlock(phone, ".changeNavigator");
    const search = cssBlock(phone, ".changeSearch");

    expect(toolbar).toContain("display: grid");
    expect(toolbar).toContain("grid-template-columns: auto minmax(0, 1fr)");
    expect(toolbar).toContain("grid-template-rows: repeat(4, 29px)");
    expect(navigator).toContain("grid-row: 1");
    expect(navigator).not.toContain("display: none");
    expect(search).toContain("min-width: 0");
    expect(search).toContain("grid-column: 2");
    expect(search).toContain("grid-row: 1");
    expect(search).not.toContain("display: none");
    expect(phone).toMatch(
      /\[aria-label="Expand or collapse files"\][\s\S]*?grid-row:\s*2/,
    );
    expect(phone).toMatch(/\.fullFileToggle\s*\{[\s\S]*?grid-row:\s*2/);
    expect(phone).toMatch(/\[aria-label="Diff layout"\][\s\S]*?grid-row:\s*3/);
    expect(phone).toMatch(/\.wrapButton\s*\{[\s\S]*?grid-row:\s*3/);
    expect(phone).toMatch(/\.contextToggle\s*\{[\s\S]*?grid-row:\s*4/);
  });
});

describe("resizable review columns", () => {
  it("bounds saved column widths before it applies them", () => {
    const storage = {
      getItem: () => JSON.stringify({ files: 9_999, context: -10 }),
    };

    expect(loadReviewLayoutWidths(storage)).toEqual({
      files: 400,
      context: 240,
    });
  });

  it("resizes changed files by drag and keyboard, then remembers the width", async () => {
    localStorage.removeItem("wts.repository-review-layout.v1");
    const { container } = render(
      <RepositoryPatchViewer patch={patch} theme="light" />,
    );
    const viewer = container.querySelector('[data-ui="changes.viewer"]') as HTMLElement;
    Object.defineProperty(viewer, "getBoundingClientRect", {
      value: () => ({ left: 0, right: 1200 }),
    });
    const separator = screen.getByRole("separator", {
      name: "Resize changed files",
    });

    expect(separator).toHaveAttribute("aria-valuenow", "244");
    fireEvent.pointerDown(separator, { clientX: 244, pointerId: 7 });
    fireEvent.pointerMove(window, { clientX: 360, pointerId: 7 });
    fireEvent.pointerUp(window, { clientX: 360, pointerId: 7 });
    expect(separator).toHaveAttribute("aria-valuenow", "360");

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).toHaveAttribute("aria-valuenow", "336");
    await waitFor(() =>
      expect(loadReviewLayoutWidths()).toMatchObject({ files: 336 }),
    );

    fireEvent.doubleClick(separator);
    expect(separator).toHaveAttribute("aria-valuenow", "244");
    localStorage.removeItem("wts.repository-review-layout.v1");
  });

  it("resizes review feedback while the code column uses the remaining space", () => {
    localStorage.removeItem("wts.repository-review-layout.v1");
    const client = {
      listWorkspaceReviewThreads: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        workspaceId: "workspace-checkout",
        threads: [],
      }),
    };
    const { container } = render(
      <RepositoryPatchViewer
        feedback={feedback(client as never, {
          gitlabReview: {
            repositoryId: "repo-checkout",
            iid: 17,
            discussions: [],
          },
        })}
        lineCommentProvider="GitLab"
        patch={patch}
        theme="light"
      />,
    );
    const separator = screen.getByRole("separator", {
      name: "Resize code review feedback",
    });

    expect(separator).toHaveAttribute("aria-valuenow", "320");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).toHaveAttribute("aria-valuenow", "344");
    expect(container.querySelector('[data-ui="changes.diff"]')).toBeVisible();
    expect(container.querySelector('[data-ui="changes.context"]')).toBeVisible();
    localStorage.removeItem("wts.repository-review-layout.v1");
  });
});

describe("lazy rendering for file diff blocks", () => {
  it("opens review context only when the user requests it", () => {
    const client = {
      listWorkspaceReviewThreads: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        workspaceId: "workspace-checkout",
        threads: [],
      }),
    };
    render(
      <RepositoryPatchViewer
        feedback={feedback(client as never)}
        patch={patch}
        theme="light"
      />,
    );

    const toggle = screen.getByRole("button", { name: "Show review context" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("complementary", { name: "Review context" }),
    ).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(
      screen.getByRole("complementary", { name: "Review context" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Related tests" })).toBeVisible();
    expect(screen.getByRole("button", { name: "References" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Feedback" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Hide review context" }),
    ).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "Close review context" }));
    expect(
      screen.queryByRole("complementary", { name: "Review context" }),
    ).not.toBeInTheDocument();
  });

  it("opens References when the user modifier-clicks a changed symbol", () => {
    expect(
      patchTokenReferenceAction("checkout", {
        ctrlKey: false,
        metaKey: true,
      }),
    ).toEqual({
      contextMode: "references",
      contextOpen: true,
      symbol: "checkout",
    });
    expect(
      patchTokenReferenceAction("checkout", {
        ctrlKey: true,
        metaKey: false,
      }),
    ).toEqual({
      contextMode: "references",
      contextOpen: true,
      symbol: "checkout",
    });
    expect(
      patchTokenReferenceAction("checkout", {
        ctrlKey: false,
        metaKey: false,
      }),
    ).toBeNull();
  });

  it("loads complete neutral context only after the selected file is requested", async () => {
    const fullPatch = `diff --git a/src/checkout.ts b/src/checkout.ts
index 1111111..2222222 100644
--- a/src/checkout.ts
+++ b/src/checkout.ts
@@ -1,4 +1,4 @@
 export const firstNeutral = true;
-export const checkout = false;
+export const checkout = true;
 export const lastNeutral = true;
 export const finalNeutral = true;
`;
    const client = {
      getWorkspaceRepositoryFileReview: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        workspaceId: "workspace-checkout",
        repositoryId: "repo-checkout",
        repositoryLabel: "checkout",
        baseCommitOid: "0123456789abcdef0123456789abcdef01234567",
        headCommitOid: "fedcba9876543210fedcba9876543210fedcba98",
        filePath: "src/checkout.ts",
        patchSha256: `sha256:${"a".repeat(64)}`,
        contentSha256: `sha256:${"b".repeat(64)}`,
        content: "complete content\n",
        fullPatch,
      }),
    };
    render(
      <RepositoryPatchViewer
        feedback={feedback(client as never)}
        patch={patch}
        theme="light"
      />,
    );

    expect(client.getWorkspaceRepositoryFileReview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Full file" }));
    expect(client.getWorkspaceRepositoryFileReview).toHaveBeenCalledWith(
      "workspace-checkout",
      "repo-checkout",
      "src/checkout.ts",
      `sha256:${"a".repeat(64)}`,
    );

    expect(
      await screen.findByText("Full file · neutral lines are unchanged"),
    ).toBeVisible();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search changed code" }),
      { target: { value: "finalNeutral" } },
    );
    expect(screen.getByText("1/1")).toBeVisible();
    expect(screen.getByText("2 changes")).toBeVisible();
  });

  it("ignores a complete-file response after the displayed patch identity changes", async () => {
    const request = deferred<{
      schemaVersion: number;
      workspaceId: string;
      repositoryId: string;
      repositoryLabel: string;
      baseCommitOid: string;
      headCommitOid: string;
      filePath: string;
      patchSha256: string;
      contentSha256: string;
      content: string;
      fullPatch: string;
    }>();
    const client = {
      getWorkspaceRepositoryFileReview: vi.fn().mockReturnValue(request.promise),
    };
    const { container, rerender } = render(
      <RepositoryPatchViewer
        feedback={feedback(client as never)}
        patch={patch}
        theme="light"
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Full file" }));

    const replacementPatch = patch.replaceAll("checkout", "replacement");
    rerender(
      <RepositoryPatchViewer
        feedback={feedback(client as never, {
          patchSha256: `sha256:${"c".repeat(64)}`,
          repositoryId: "repo-replacement",
        })}
        patch={replacementPatch}
        theme="light"
      />,
    );
    await act(async () => {
      request.resolve({
        schemaVersion: 1,
        workspaceId: "workspace-checkout",
        repositoryId: "repo-checkout",
        repositoryLabel: "checkout",
        baseCommitOid: "0123456789abcdef0123456789abcdef01234567",
        headCommitOid: "fedcba9876543210fedcba9876543210fedcba98",
        filePath: "src/checkout.ts",
        patchSha256: `sha256:${"a".repeat(64)}`,
        contentSha256: `sha256:${"b".repeat(64)}`,
        content: "stale complete content\n",
        fullPatch: patch,
      });
      await request.promise;
    });

    expect(
      container.querySelector('[data-full-file="true"]'),
    ).toBeNull();
    expect(
      screen.queryByText("Full file · neutral lines are unchanged"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Full file" })).not.toBeChecked();
  });

  it("rejects complete-file content from a newer unstaged patch", async () => {
    const client = {
      getWorkspaceRepositoryFileReview: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        workspaceId: "workspace-checkout",
        repositoryId: "repo-checkout",
        repositoryLabel: "checkout",
        baseCommitOid: "0123456789abcdef0123456789abcdef01234567",
        headCommitOid: "fedcba9876543210fedcba9876543210fedcba98",
        filePath: "src/checkout.ts",
        patchSha256: `sha256:${"c".repeat(64)}`,
        contentSha256: `sha256:${"b".repeat(64)}`,
        content: "newer content\n",
        fullPatch: patch,
      }),
    };
    const { container } = render(
      <RepositoryPatchViewer
        feedback={feedback(client as never)}
        patch={patch}
        theme="light"
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Full file" }));

    expect(
      await screen.findByText(
        "The repository changed. Reload the changes and try again.",
      ),
    ).toBeVisible();
    expect(container.querySelector('[data-full-file="true"]')).toBeNull();
  });

  it("renders collapsed file diffs lazily, expands on selection, and supports expand all", () => {
    const { container } = render(
      <RepositoryPatchViewer patch={multiFilePatch} theme="light" />,
    );

    // Initial state: only the first intended file is expanded.
    const file1Summary = summarizeRepositoryPatch(multiFilePatch);
    const file4 = file1Summary.files.find((f) => f.fileDiff.name === "src/file4.ts")!;
    const file1 = file1Summary.files.find((f) => f.fileDiff.name === "src/file1.ts")!;

    // Diff body for file1 should be mounted in DOM
    expect(container.querySelector(`[id="diff-body-${file1.id}"]`)).not.toBeNull();

    // Every other diff body should stay unmounted until it is requested.
    for (const file of file1Summary.files.slice(1)) {
      expect(container.querySelector(`[id="diff-body-${file.id}"]`)).toBeNull();
    }

    // Find header for file4 and activate it
    const file4Header = container.querySelector(
      `button[aria-controls="diff-body-${file4.id}"]`,
    )!;
    expect(file4Header).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(file4Header);

    // Now diff body for file4 should be mounted in DOM
    expect(container.querySelector(`[id="diff-body-${file4.id}"]`)).not.toBeNull();
    expect(file4Header).toHaveAttribute("aria-expanded", "true");

    // Click "Expand all" button
    const expandAllButton = screen.getByRole("button", { name: /^Expand all$/i });
    fireEvent.click(expandAllButton);

    // All file diff bodies should now be mounted in DOM
    for (const file of file1Summary.files) {
      expect(container.querySelector(`[id="diff-body-${file.id}"]`)).not.toBeNull();
    }

    // Click "Collapse all" button
    const collapseAllButton = screen.getByRole("button", { name: /^Collapse all$/i });
    fireEvent.click(collapseAllButton);

    // All file diff bodies should now be unmounted from DOM
    for (const file of file1Summary.files) {
      expect(container.querySelector(`[id="diff-body-${file.id}"]`)).toBeNull();
    }
  });

  it("toggles the selected file from the file list after collapse all", () => {
    const { container } = render(
      <RepositoryPatchViewer patch={multiFilePatch} theme="light" />,
    );
    const summary = summarizeRepositoryPatch(multiFilePatch);
    const file = summary.files[0];
    const fileListButton = screen.getByRole("button", {
      name: /src\/file1\.ts, modified/i,
    });
    fireEvent.click(screen.getByRole("button", { name: /^Collapse all$/i }));

    fireEvent.click(fileListButton);
    expect(container.querySelector(`[id="diff-body-${file.id}"]`)).not.toBeNull();

    fireEvent.click(fileListButton);
    expect(container.querySelector(`[id="diff-body-${file.id}"]`)).toBeNull();
  });

  it("jumps between hunks across files and expands each target", () => {
    const { container } = render(
      <RepositoryPatchViewer patch={multiFilePatch} theme="light" />,
    );
    const summary = summarizeRepositoryPatch(multiFilePatch);
    const next = screen.getByRole("button", { name: "Next change" });

    expect(screen.getByText("5 changes")).toBeInTheDocument();
    fireEvent.click(next);
    expect(screen.getByText("1/5")).toBeInTheDocument();
    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent.click(next);

    const fourth = summary.files[3];
    expect(screen.getByText("4/5")).toBeInTheDocument();
    expect(
      container.querySelector(`[id="diff-body-${fourth.id}"]`),
    ).not.toBeNull();
    expect(
      container.querySelector(`[id="file-block-${fourth.id}"]`),
    ).toHaveAttribute("data-active-change");

    fireEvent.keyDown(window, { altKey: true, key: "ArrowUp" });
    expect(screen.getByText("3/5")).toBeInTheDocument();
  });

  it("uses exact previous and next keyboard behavior without capturing form input", () => {
    render(<RepositoryPatchViewer patch={multiFilePatch} theme="light" />);
    const search = screen.getByRole("searchbox", {
      name: "Search changed code",
    });

    fireEvent.keyDown(window, { altKey: true, key: "ArrowUp" });
    expect(screen.getByText("5/5")).toBeInTheDocument();

    fireEvent.keyDown(window, { altKey: true, key: "ArrowDown" });
    expect(screen.getByText("1/5")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous change" }));
    expect(screen.getByText("5/5")).toBeInTheDocument();

    fireEvent.keyDown(search, { altKey: true, key: "ArrowDown" });
    expect(screen.getByText("5/5")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    expect(screen.getByText("1/5")).toBeInTheDocument();
  });

  it("keeps the change navigator available by scrolling only the review pane", async () => {
    const { container } = render(
      <RepositoryPatchViewer patch={multiFilePatch} theme="light" />,
    );
    const reviewScroller = screen.getByTestId("patch-review-scroll");
    expect(reviewScroller.closest('[data-ui="changes.code"]')).toHaveAttribute(
      "data-history-swipe-block",
    );
    const firstFile = summarizeRepositoryPatch(multiFilePatch).files[0]!;
    const firstFileBlock = container.querySelector(
      `[id="file-block-${firstFile.id}"]`,
    ) as HTMLElement;
    const scrollTo = vi.fn();
    const scrollIntoView = vi.fn();
    Object.defineProperty(reviewScroller, "scrollTo", { value: scrollTo });
    Object.defineProperty(reviewScroller, "scrollTop", { value: 30 });
    Object.defineProperty(reviewScroller, "getBoundingClientRect", {
      value: () => ({ top: 100 }),
    });
    Object.defineProperty(firstFileBlock, "getBoundingClientRect", {
      value: () => ({ top: 800 }),
    });
    Object.defineProperty(firstFileBlock, "scrollIntoView", {
      value: scrollIntoView,
    });

    fireEvent.click(screen.getByRole("button", { name: "Next change" }));

    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: "auto", top: 730 }),
      ),
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Next change" })).toBeVisible();
  });

  it("resets patch-derived state while preserving review preferences", async () => {
    const replacementPatch = `diff --git a/src/replacement.ts b/src/replacement.ts
index 1111111..2222222 100644
--- a/src/replacement.ts
+++ b/src/replacement.ts
@@ -1 +1 @@
-export const replacement = false;
+export const replacement = true;
`;
    const { container, rerender } = render(
      <RepositoryPatchViewer patch={patch} theme="light" />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Show tests:/i }),
    );
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search changed code" }),
      { target: { value: "checkout" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    fireEvent.click(screen.getByRole("button", { name: "Wrap lines" }));

    rerender(
      <RepositoryPatchViewer patch={replacementPatch} theme="light" />,
    );

    const replacement = summarizeRepositoryPatch(replacementPatch).files[0]!;
    await waitFor(() => {
      expect(
        screen.getByRole("searchbox", { name: "Search changed code" }),
      ).toHaveValue("");
      expect(screen.getByText("1 change")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Split" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: "Wrap lines" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        screen.getByRole("button", { name: /Show code:/i }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(
        container.querySelector(`[id="diff-body-${replacement.id}"]`),
      ).not.toBeNull();
    });
  });

  it("maps code search results to exact lines and reports the active match", () => {
    const fullContextPatch = `diff --git a/src/complete.ts b/src/complete.ts
index 1111111..2222222 100644
--- a/src/complete.ts
+++ b/src/complete.ts
@@ -1,4 +1,4 @@
 export const first = true;
-export const target = false;
+export const target = true;
 export const neutral = "not changed";
 export const last = true;
`;
    const summary = summarizeRepositoryPatch(fullContextPatch);
    expect(findPatchSearchMatches(summary.files, "neutral")).toEqual([
      expect.objectContaining({
        fileName: "src/complete.ts",
        lineNumber: 3,
        side: "additions",
      }),
    ]);
    expect(
      patchSearchNavigation(findPatchSearchMatches(summary.files, "neutral")[0]),
    ).toEqual({
      selection: {
        id: summary.files[0].id,
        range: { start: 3, end: 3, side: "additions" },
      },
      scrollTarget: expect.objectContaining({
        type: "line",
        id: summary.files[0].id,
        lineNumber: 3,
        align: "center",
      }),
    });

    render(<RepositoryPatchViewer patch={fullContextPatch} theme="light" />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search changed code" }), {
      target: { value: "neutral" },
    });

    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(
      screen.getByText("Unchanged context"),
    ).toBeInTheDocument();
  });
});
