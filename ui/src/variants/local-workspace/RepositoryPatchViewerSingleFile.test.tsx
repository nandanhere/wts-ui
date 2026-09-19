import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import { RepositoryPatchViewer } from "./RepositoryPatchViewer";

const patch = "diff --git a/src/retry.ts b/src/retry.ts\nindex 1111111..2222222 100644\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1,2 @@\n-const retries = 1;\n+const retries = 3;\n+const retriesEnabled = true;\n";

describe("single-file review controls", () => {
  it("keeps callouts and controlled DOM regions distinct from a recorded result viewer", async () => {
    const user = userEvent.setup();
    const view = render(<><RepositoryPatchViewer patch={patch} theme="dark" /><RepositoryPatchViewer patch={patch} theme="dark" calloutPrefix={{ id: "agent-result-review", label: "Task result" }} /></>);
    for (const control of screen.getAllByRole("button", { name: "Show review context" })) await user.click(control);
    const ids = Array.from(view.container.querySelectorAll("[data-ui]"), element => element.getAttribute("data-ui"));
    const labels = Array.from(view.container.querySelectorAll("[data-ui-label]"), element => element.getAttribute("data-ui-label"));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
    expect(view.container.querySelector('[data-ui="changes.viewer"]')).toBeInTheDocument();
    expect(view.container.querySelector('[data-ui="agent-result-review.viewer"]')).toHaveAttribute("data-ui-label", "Task result: Code changes viewer");
    const domIds = Array.from(view.container.querySelectorAll("[id]"), element => element.id);
    expect(new Set(domIds).size).toBe(domIds.length);
    for (const control of screen.getAllByRole("button", { name: "Hide review context" })) {
      expect(view.container.querySelector(`[id="${control.getAttribute("aria-controls")}"]`)).toBeVisible();
    }
  });

  it("keeps primary tools visible and opens secondary tools from a keyboard menu", async () => {
    const user = userEvent.setup();
    const view = render(<RepositoryPatchViewer patch={patch} theme="dark" singleFile />);
    const toolbar = within(view.container.querySelector('[data-ui="changes.toolbar"]') as HTMLElement);
    expect(toolbar.queryByRole("button", { name: "Show review context" })).not.toBeInTheDocument();
    expect(toolbar.queryByRole("button", { name: "Collapse all" })).not.toBeInTheDocument();
    expect(toolbar.queryByText("Unchanged context")).not.toBeInTheDocument();
    expect(toolbar.getByRole("button", { name: "Unified" })).toHaveAttribute("aria-pressed", "true");
    await user.click(toolbar.getByRole("button", { name: "Split" }));
    expect(toolbar.getByRole("button", { name: "Split" })).toHaveAttribute("aria-pressed", "true");
    await user.click(toolbar.getByRole("button", { name: "Wrap lines" }));
    expect(toolbar.getByRole("button", { name: "Wrap lines" })).toHaveAttribute("aria-pressed", "true");
    await user.type(toolbar.getByRole("searchbox", { name: "Search changed code" }), "retries");
    expect(toolbar.getByText("1/2")).toBeVisible();
    await user.keyboard("{Enter}");
    expect(toolbar.getByText("2/2")).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(toolbar.getByRole("button", { name: "Next change" }));
    expect(toolbar.getByText("1/1")).toBeVisible();
    const options = toolbar.getByRole("button", { name: "Diff options" });
    options.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("menuitem", { name: "Show review context" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("complementary", { name: "Review context" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close review context" }));
    await user.click(options);
    expect(screen.getByText("Lines without + or − are unchanged.")).toBeVisible();
    await user.click(screen.getByRole("menuitem", { name: "Collapse file" }));
    expect(view.container.querySelector("diffs-container")).toBeNull();
    await user.click(options);
    await user.click(screen.getByRole("menuitem", { name: "Expand file" }));
    await waitFor(() => expect(view.container.querySelector("diffs-container")).not.toBeNull());
  });

  it("keeps file actions separate from collapse and loads full-file context only on request", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    const onEdit = vi.fn();
    const identity = { client: fake.client, workspaceId: "workspace-review", repositoryId: "repo_retry", baseCommitOid: "a".repeat(40), headCommitOid: "b".repeat(40), patchSha256: `sha256:${"c".repeat(64)}` };
    fake.getWorkspaceRepositoryFileReview.mockReturnValue(new Promise(() => {}));
    render(<RepositoryPatchViewer patch={patch} theme="light" singleFile feedback={identity} singleFileActions={<button onClick={onEdit}>Edit locally</button>} />);
    await user.click(screen.getByRole("button", { name: "Edit locally" }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /src\/retry.ts/ })).toHaveAttribute("aria-expanded", "true");
    expect(fake.getWorkspaceRepositoryFileReview).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Diff options" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Full file" }));
    expect(fake.getWorkspaceRepositoryFileReview).toHaveBeenCalledWith(identity.workspaceId, identity.repositoryId, "src/retry.ts", identity.patchSha256);
  });
});
