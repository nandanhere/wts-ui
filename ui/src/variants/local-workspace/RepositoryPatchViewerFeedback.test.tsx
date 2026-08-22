import { forwardRef, type ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";

vi.mock("@pierre/diffs/react", () => ({
  CodeView: forwardRef(function FakeCodeView(
    props: {
      items: Array<{ id: string }>;
      onSelectedLinesChange?: (selection: {
        id: string;
        range: { start: number; side: "additions" };
      }) => void;
      renderGutterUtility?: (
        getHoveredLine: () => { lineNumber: number; side: "additions" },
        item: { id: string },
      ) => ReactNode;
      options?: { enableGutterUtility?: boolean };
    },
    _ref,
  ) {
    return (
      <>
        {props.options?.enableGutterUtility
          ? props.renderGutterUtility?.(
              () => ({ lineNumber: 1, side: "additions" }),
              props.items[0]!,
            )
          : null}
      </>
    );
  }),
}));

import { RepositoryPatchViewer } from "./RepositoryPatchViewer";

describe("GitLab line comment affordance", () => {
  it("shows a line comment control and opens the focused composer", async () => {
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceReviewThreads.mockResolvedValue({
      workspaceId: "workspace-review",
      threads: [],
    });

    render(
      <RepositoryPatchViewer
        feedback={{
          baseCommitOid: "a".repeat(40),
          client: fake.client,
          gitlabReview: {
            repositoryId: "repo_orders",
            iid: 17,
            discussions: [],
          },
          headCommitOid: "b".repeat(40),
          patchSha256: "provider",
          repositoryId: "repo_orders",
          workspaceId: "workspace-review",
        }}
        lineCommentProvider="GitLab"
        patch={[
          "diff --git a/src/orders.ts b/src/orders.ts",
          "--- a/src/orders.ts",
          "+++ b/src/orders.ts",
          "@@ -1 +1 @@",
          "-export const ready = false;",
          "+export const ready = true;",
          "",
        ].join("\n")}
        theme="dark"
      />,
    );

    expect(screen.getByRole("complementary", { name: "Review context" })).toBeVisible();
    expect(screen.getByText("Select a changed line")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Comment on added line 1" }));

    const composer = await screen.findByRole("textbox", { name: "Review comment" });
    await waitFor(() => expect(composer).toHaveFocus());
    expect(screen.getByText("src/orders.ts:+1")).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish to GitLab" })).toBeVisible();
  });
});
