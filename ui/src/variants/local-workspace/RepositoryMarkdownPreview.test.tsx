import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import { RepositoryPatchViewer } from "./RepositoryPatchViewer";

const patch = (name = "README.md", heading = "New heading") => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,2 +1,2 @@\n-# Old heading\n+# ${heading}\n text\n`;
const completePatch = patch().replace("@@ -1,2 +1,2 @@", "@@ -1,3 +1,3 @@") + " complete context\n";
function setup() {
  const fake = fakeWorkspaceClient();
  const feedback = { client: fake.client, workspaceId: "w", repositoryId: "r", baseCommitOid: "a", headCommitOid: "b", patchSha256: "hash" };
  const response = { schemaVersion: 1, ...feedback, repositoryLabel: "Repository", filePath: "README.md", contentSha256: "content", content: "# New heading\ntext\ncomplete context\n", fullPatch: completePatch };
  return { fake, feedback, response };
}

describe("Markdown preview in the patch viewer", () => {
  it("toggles rendered Markdown and the diff without a file request for a recorded patch", async () => {
    const user = userEvent.setup();
    const view = render(<RepositoryPatchViewer patch={patch()} theme="dark" singleFile />);
    const toggle = screen.getByRole("button", { name: "Preview Markdown for README.md" });
    expect(screen.queryByRole("heading", { name: "New heading" })).not.toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByRole("heading", { name: "New heading" })).toBeVisible();
    expect(screen.getByText(/Patch excerpts only/)).toBeVisible();
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(view.container.querySelector("diffs-container")).toBeNull();
    await user.click(toggle);
    expect(screen.queryByRole("heading", { name: "New heading" })).not.toBeInTheDocument();
    expect(view.container.querySelector("diffs-container")).not.toBeNull();
  });

  it("requests and validates the complete file only after a click", async () => {
    const { fake, feedback, response } = setup();
    fake.getWorkspaceRepositoryFileReview.mockResolvedValue(response);
    const user = userEvent.setup();
    render(<RepositoryPatchViewer patch={patch()} feedback={feedback} theme="light" />);
    expect(fake.getWorkspaceRepositoryFileReview).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Preview Markdown for README.md" }));
    expect(await screen.findByText(/complete context/)).toBeVisible();
    expect(screen.getByText(/Complete file/)).toBeVisible();
    expect(fake.getWorkspaceRepositoryFileReview).toHaveBeenCalledWith("w", "r", "README.md", "hash");
    expect(screen.queryByRole("heading", { name: "Old heading" })).not.toBeInTheDocument();
  });

  it("rejects a mismatched response and labels the fallback excerpts", async () => {
    const { fake, feedback, response } = setup();
    fake.getWorkspaceRepositoryFileReview.mockResolvedValue({ ...response, patchSha256: "other" });
    render(<RepositoryPatchViewer patch={patch()} feedback={feedback} theme="dark" />);
    await userEvent.click(screen.getByRole("button", { name: "Preview Markdown for README.md" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The repository changed.");
    expect(screen.queryByText(/complete context/)).not.toBeInTheDocument();
    expect(screen.getByText(/Patch excerpts only/)).toBeVisible();
  });

  it("resets the preview on comparison changes and excludes other file types", async () => {
    const view = render(<RepositoryPatchViewer patch={patch("GUIDE.MD")} theme="dark" />);
    await userEvent.click(screen.getByRole("button", { name: "Preview Markdown for GUIDE.MD" }));
    view.rerender(<RepositoryPatchViewer patch={patch("GUIDE.MD", "Updated")} theme="dark" />);
    expect(screen.getByRole("button", { name: "Preview Markdown for GUIDE.MD" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("region", { name: /Markdown preview/ })).not.toBeInTheDocument();
    view.rerender(<RepositoryPatchViewer patch={patch("code.ts")} theme="dark" />);
    expect(screen.queryByRole("button", { name: /Preview Markdown/ })).not.toBeInTheDocument();
  });

  it("renders deleted Markdown, GFM tables, and safe links without executable HTML or remote images", async () => {
    const body = ['# Deleted guide', '', '| Name | Value |', '| --- | --- |', '| a | b |', '', '[Safe](https://example.com)', '[Unsafe](javascript:alert%281%29)', '[Local](./other.md)', '![Remote](https://example.com/image.png)', '<script>alert(1)</script>'];
    const deleted = `diff --git a/old.markdown b/old.markdown\ndeleted file mode 100644\n--- a/old.markdown\n+++ /dev/null\n@@ -1,${body.length} +0,0 @@\n${body.map(line => `-${line}`).join("\n")}\n`;
    const view = render(<RepositoryPatchViewer patch={deleted} theme="dark" />);
    await userEvent.click(screen.getByRole("button", { name: "Preview Markdown for old.markdown" }));
    const preview = within(screen.getByRole("region", { name: "Markdown preview for old.markdown" }));
    expect(preview.getByRole("heading", { name: "Deleted guide" })).toBeVisible();
    expect(preview.getByRole("table")).toBeVisible();
    expect(preview.getByRole("link", { name: "Safe" })).toHaveAttribute("rel", "noreferrer");
    expect(preview.getAllByRole("link")).toHaveLength(1);
    expect(view.container.querySelector("script, img")).toBeNull();
  });

  it("ignores a pending file response after the comparison changes", async () => {
    const { fake, feedback, response } = setup();
    let resolve!: (value: typeof response) => void;
    fake.getWorkspaceRepositoryFileReview.mockReturnValue(new Promise(done => { resolve = done; }));
    const view = render(<RepositoryPatchViewer patch={patch()} feedback={feedback} theme="dark" />);
    await userEvent.click(screen.getByRole("button", { name: "Preview Markdown for README.md" }));
    expect(screen.getByText("WTS reads the complete file…")).toHaveAttribute("role", "status");
    view.rerender(<RepositoryPatchViewer patch={patch("OTHER.md")} feedback={{ ...feedback, patchSha256: "next" }} theme="dark" />);
    await act(async () => { resolve(response); });
    expect(screen.queryByText(/complete context/)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Markdown preview for README.md" })).not.toBeInTheDocument();
  });
});

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: mermaid }));

function diagramPatch(source: string) {
  const lines = ["# Diagram", "```mermaid", source, "```", "```js", "const value = 1;", "```"].join("\n").split("\n");
  return `diff --git a/README.md b/README.md\nnew file mode 100644\n--- /dev/null\n+++ b/README.md\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join("\n")}\n`;
}

describe("Mermaid in repository Markdown", () => {
  beforeEach(() => {
    mermaid.initialize.mockClear();
    mermaid.render.mockReset();
    mermaid.render.mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" onload="alert(1)"><script>alert(1)</script><text>Flow</text></svg>' });
  });

  it("renders a fenced diagram through the preview toggle with safe SVG and zoom controls", async () => {
    render(<RepositoryPatchViewer patch={diagramPatch("flowchart LR\nStart --> End")} theme="dark" />);
    expect(mermaid.render).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Preview Markdown for README.md" }));
    const diagram = await screen.findByRole("img", { name: "Mermaid diagram" });
    expect(diagram).toHaveTextContent("Flow");
    expect(diagram.querySelector("script, [onload]")).toBeNull();
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), "flowchart LR\nStart --> End");
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", startOnLoad: false }));
    expect(screen.getByRole("button", { name: "Reset diagram zoom" })).toBeVisible();
    expect(screen.getByText("const value = 1;").closest("pre")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Preview Markdown for README.md" }));
    expect(screen.queryByRole("img", { name: "Mermaid diagram" })).not.toBeInTheDocument();
  });

  it("keeps invalid diagram source readable when rendering fails", async () => {
    mermaid.render.mockRejectedValue(new Error("Invalid diagram"));
    render(<RepositoryPatchViewer patch={diagramPatch("invalid diagram")} theme="dark" />);
    await userEvent.click(screen.getByRole("button", { name: "Preview Markdown for README.md" }));
    expect(await screen.findByText("WTS could not render this diagram.")).toBeVisible();
    expect(screen.getByText("invalid diagram").closest("pre")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Diagram" })).toBeVisible();
  });
});
