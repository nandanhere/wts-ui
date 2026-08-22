import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  MaterializedWorktree,
  GitlabReviewPatch,
  WorkspaceEvidence,
  WorkspaceMaterialization,
  WorkspaceRepositoryDiff,
} from "../../lib/wtsClient";
import {
  fakeWorkspaceClient,
  workspaceEvidenceFixture,
} from "../../test/workspaceClientFake";
import {
  RepositoryReviewScreen,
  REVIEW_PATCH_POLL_INTERVAL_MS,
} from "./RepositoryReviewScreen";

const baseCommitOid = "0123456789abcdef0123456789abcdef01234567";
const headCommitOid = "fedcba9876543210fedcba9876543210fedcba98";

function worktree(
  repositoryId: string,
  activity?: MaterializedWorktree["activity"],
): MaterializedWorktree {
  return {
    repositoryId,
    label: repositoryId,
    targetDisplayPath: `/tmp/workspace/${repositoryId}`,
    branchName: "wts/review",
    baseCommitOid,
    ...(activity ? { activity } : {}),
  };
}

function materialization(
  workspaceId: string,
  worktrees: MaterializedWorktree[],
): WorkspaceMaterialization {
  return {
    schemaVersion: 1,
    workspaceId,
    workspaceRecordVersion: 1,
    effectDigest: `sha256:${workspaceId}`,
    workspaceDisplayPath: `/tmp/${workspaceId}`,
    codeWorkspaceDisplayPath: `/tmp/${workspaceId}/workspace.code-workspace`,
    branchName: "wts/review",
    worktrees,
    graph: {
      status: "notStarted",
      detail: "The graph is not ready.",
    },
  };
}

function repositoryDiff(
  workspaceId: string,
  repositoryId: string,
  changed = true,
): WorkspaceRepositoryDiff {
  return {
    schemaVersion: 1,
    workspaceId,
    repositoryId,
    repositoryLabel: repositoryId,
    baseCommitOid,
    headCommitOid,
    patchSha256: `sha256:${"a".repeat(64)}`,
    patch: changed
      ? `diff --git a/src/${repositoryId}.ts b/src/${repositoryId}.ts
index 1111111..2222222 100644
--- a/src/${repositoryId}.ts
+++ b/src/${repositoryId}.ts
@@ -1 +1 @@
-export const changed = false;
+export const changed = true;
`
      : "",
    patchTruncated: false,
    untrackedPaths: [],
    untrackedPathsTruncated: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

describe("RepositoryReviewScreen repository selection", () => {
  it("keeps the loaded review mounted while the background poll checks GitLab", async () => {
    const workspaceId = "ws_stable_gitlab_review";
    const fake = fakeWorkspaceClient();
    let poll: (() => void) | undefined;
    const interval = vi
      .spyOn(window, "setInterval")
      .mockImplementation(
        ((handler: unknown, timeout?: number) => {
          if (
            timeout === REVIEW_PATCH_POLL_INTERVAL_MS &&
            typeof handler === "function"
          ) {
            poll = handler as () => void;
          }
          return 1;
        }) as unknown as typeof window.setInterval,
      );
    const firstPatch: GitlabReviewPatch = {
      schemaVersion: 1,
      repositoryId: "provider_baseboard_api",
      iid: 24,
      baseCommitOid,
      startCommitOid: baseCommitOid,
      headCommitOid,
      commits: [],
      discussions: [],
      patch: repositoryDiff(workspaceId, "repo_review").patch,
      patchTruncated: false,
      fromCache: false,
      fetchedAtUnixMs: 1_787_134_945_000,
    };
    fake.getGitlabReviewPatch.mockResolvedValueOnce(firstPatch);

    render(
      <RepositoryReviewScreen
        client={fake.client}
        gitlabReview={{
          id: "review-24",
          repositoryId: "provider_baseboard_api",
          repository: "devtools/baseboard-api",
          number: 24,
          title: "Validate Redfish sessions",
          authorLogin: "dave",
          sourceBranch: "DEVTOOLS-7217",
          targetBranch: "develop",
          updatedAt: "2026-08-21T06:00:00Z",
          draft: false,
          reviewState: "requested",
          status: "open",
        }}
        initialRepositoryId="repo_review"
        materialization={materialization(workspaceId, [
          { ...worktree("repo_review"), label: "baseboard-api" },
        ])}
        onRepositoryChange={() => undefined}
        workspaceId={workspaceId}
      />,
    );

    expect(await screen.findByText("devtools/baseboard-api changes")).toBeVisible();
    expect(screen.getByTestId("patch-review-scroll")).toBeVisible();

    const refresh = deferred<GitlabReviewPatch>();
    fake.getGitlabReviewPatch.mockReturnValueOnce(refresh.promise);
    act(() => poll?.());

    await waitFor(() => expect(fake.getGitlabReviewPatch).toHaveBeenCalledTimes(2));
    expect(screen.getByText("devtools/baseboard-api changes")).toBeVisible();
    expect(screen.getByTestId("patch-review-scroll")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Checking GitLab" }),
    ).toBeDisabled();

    refresh.resolve(firstPatch);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Check for new commits" }),
      ).toBeEnabled(),
    );
    interval.mockRestore();
  });

  it("loads the provider patch for a matching GitLab review workspace", async () => {
    const workspaceId = "ws_gitlab_review";
    const fake = fakeWorkspaceClient();
    fake.getGitlabReviewPatch.mockResolvedValue({
      schemaVersion: 1,
      repositoryId: "provider_apex_api",
      iid: 9,
      baseCommitOid,
      startCommitOid: baseCommitOid,
      headCommitOid,
      commits: [{
        oid: "c".repeat(40),
        parentOid: baseCommitOid,
        shortId: "cccccccc",
        title: "Refactor logging",
        authorName: "Dave",
        authoredAt: "2026-08-19T09:00:00Z",
      }],
      discussions: [],
      patch: repositoryDiff(workspaceId, "repo_review").patch,
      patchTruncated: false,
      fromCache: false,
      fetchedAtUnixMs: 1_787_134_945_000,
    });

    render(
      <RepositoryReviewScreen
        client={fake.client}
        gitlabReview={{
          id: "99",
          repositoryId: "provider_apex_api",
          repository: "devtools/apex-api",
          number: 9,
          title: "Validate offset",
          authorLogin: "dave",
          sourceBranch: "DEVTOOLS-6349",
          targetBranch: "develop",
          updatedAt: "2026-08-18T06:00:00Z",
          draft: false,
          reviewState: "requested",
          status: "open",
        }}
        initialRepositoryId="repo_review"
        materialization={materialization(workspaceId, [
          { ...worktree("repo_review"), label: "apex-api" },
        ])}
        onRepositoryChange={() => undefined}
        workspaceId={workspaceId}
      />,
    );

    expect(await screen.findByText("devtools/apex-api changes")).toBeVisible();
    expect(fake.getGitlabReviewPatch).toHaveBeenCalledWith(
      "provider_apex_api",
      9,
    );
    expect(fake.getWorkspaceRepositoryDiff).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "GitLab MR !9 · Select a changed line to comment in GitLab.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Comment on a changed line.")).toBeVisible();
    fake.getGitlabReviewPatch.mockResolvedValueOnce({
      schemaVersion: 1,
      repositoryId: "provider_apex_api",
      iid: 9,
      baseCommitOid,
      startCommitOid: baseCommitOid,
      headCommitOid: "d".repeat(40),
      commits: [
        {
          oid: "d".repeat(40),
          parentOid: "c".repeat(40),
          shortId: "dddddddd",
          title: "Adjust logging again",
          authorName: "Dave",
          authoredAt: "2026-08-20T09:00:00Z",
        },
        {
          oid: "c".repeat(40),
          parentOid: baseCommitOid,
          shortId: "cccccccc",
          title: "Refactor logging",
          authorName: "Dave",
          authoredAt: "2026-08-19T09:00:00Z",
        },
      ],
      discussions: [],
      patch: repositoryDiff(workspaceId, "repo_review").patch,
      patchTruncated: false,
      fromCache: false,
      fetchedAtUnixMs: 1_787_221_345_000,
    });
    fireEvent.click(screen.getByRole("button", { name: "Check for new commits" }));
    await waitFor(() => expect(fake.getGitlabReviewPatch).toHaveBeenLastCalledWith(
      "provider_apex_api",
      9,
      undefined,
      true,
    ));
    expect(await screen.findByText("New changes loaded at dddddddd.")).toBeVisible();
    expect(screen.getByText("2 commits")).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "Merge request changes" }), {
      target: { value: "c".repeat(40) },
    });
    await waitFor(() => expect(fake.getGitlabReviewPatch).toHaveBeenLastCalledWith(
      "provider_apex_api",
      9,
      "c".repeat(40),
    ));
  });

  it("requests the first repository with observed activity without probing a clean repo", async () => {
    const workspaceId = "ws_activity";
    const fake = fakeWorkspaceClient();
    const onRepositoryChange = vi.fn();
    fake.getWorkspaceRepositoryDiff.mockImplementation(
      async (requestedWorkspaceId, repositoryId) =>
        repositoryDiff(requestedWorkspaceId, repositoryId),
    );

    render(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={materialization(workspaceId, [
          worktree("repo_clean", { changedFileCount: 0, commitsAhead: 0 }),
          worktree("repo_changed", { changedFileCount: 3, commitsAhead: 0 }),
        ])}
        onRepositoryChange={onRepositoryChange}
        workspaceId={workspaceId}
      />,
    );

    expect(await screen.findByText("repo_changed changes")).toBeVisible();
    expect(fake.getWorkspaceRepositoryDiff.mock.calls).toEqual([
      [workspaceId, "repo_changed"],
    ]);
    expect(onRepositoryChange).toHaveBeenCalledOnce();
    expect(onRepositoryChange).toHaveBeenCalledWith("repo_changed");
    expect(
      screen.getByRole("combobox", { name: "Repository to review" }),
    ).toHaveValue("repo_changed");
  });

  it("checks every repository when the activity snapshot reports no changes", async () => {
    const workspaceId = "ws_clean";
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockImplementation(
      async (requestedWorkspaceId, repositoryId) =>
        repositoryDiff(requestedWorkspaceId, repositoryId, false),
    );

    render(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={materialization(workspaceId, [
          worktree("repo_one", { changedFileCount: 0, commitsAhead: 0 }),
          worktree("repo_two", { changedFileCount: 0, commitsAhead: 0 }),
        ])}
        onRepositoryChange={() => undefined}
        workspaceId={workspaceId}
      />,
    );

    expect(await screen.findByText("No local changes")).toBeVisible();
    expect(fake.getWorkspaceRepositoryDiff.mock.calls).toEqual([
      [workspaceId, "repo_one"],
      [workspaceId, "repo_two"],
    ]);
  });

  it("does not report an untracked-only repository as clean", async () => {
    const workspaceId = "ws_untracked";
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockResolvedValue({
      ...repositoryDiff(workspaceId, "repo_untracked", false),
      untrackedPaths: ["src/new-worker.ts"],
    });

    render(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={materialization(workspaceId, [
          worktree("repo_untracked", { changedFileCount: 1, commitsAhead: 0 }),
        ])}
        onRepositoryChange={() => undefined}
        workspaceId={workspaceId}
      />,
    );

    expect(await screen.findByText("Untracked files need review")).toBeVisible();
    expect(screen.getByText("src/new-worker.ts")).toBeVisible();
    expect(screen.queryByText("No local changes")).not.toBeInTheDocument();
  });

  it("stops an obsolete repository probe when the workspace changes", async () => {
    const oldRequest = deferred<WorkspaceRepositoryDiff>();
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockImplementation(
      async (workspaceId, repositoryId) => {
        if (workspaceId === "ws_old" && repositoryId === "repo_old_one") {
          return oldRequest.promise;
        }
        return repositoryDiff(workspaceId, repositoryId);
      },
    );
    const { rerender } = render(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={materialization("ws_old", [
          worktree("repo_old_one"),
          worktree("repo_old_two"),
        ])}
        onRepositoryChange={() => undefined}
        workspaceId="ws_old"
      />,
    );

    await waitFor(() =>
      expect(fake.getWorkspaceRepositoryDiff).toHaveBeenCalledWith(
        "ws_old",
        "repo_old_one",
      ),
    );
    rerender(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={materialization("ws_new", [
          worktree("repo_new", { changedFileCount: 1, commitsAhead: 0 }),
        ])}
        onRepositoryChange={() => undefined}
        workspaceId="ws_new"
      />,
    );

    expect(await screen.findByText("repo_new changes")).toBeVisible();
    await act(async () => {
      oldRequest.resolve(repositoryDiff("ws_old", "repo_old_one", false));
      await oldRequest.promise;
    });

    expect(fake.getWorkspaceRepositoryDiff).not.toHaveBeenCalledWith(
      "ws_old",
      "repo_old_two",
    );
    expect(screen.getByText("repo_new changes")).toBeVisible();
  });

  it("stops an obsolete probe after its in-flight request fails", async () => {
    const oldRequest = deferred<WorkspaceRepositoryDiff>();
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockImplementation(
      async (workspaceId, repositoryId) => {
        if (workspaceId === "ws_old" && repositoryId === "repo_old_one") {
          return oldRequest.promise;
        }
        return repositoryDiff(workspaceId, repositoryId);
      },
    );
    const { rerender } = render(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={materialization("ws_old", [
          worktree("repo_old_one"),
          worktree("repo_old_two"),
        ])}
        onRepositoryChange={() => undefined}
        workspaceId="ws_old"
      />,
    );

    await waitFor(() =>
      expect(fake.getWorkspaceRepositoryDiff).toHaveBeenCalledWith(
        "ws_old",
        "repo_old_one",
      ),
    );
    rerender(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={materialization("ws_new", [
          worktree("repo_new", { changedFileCount: 1, commitsAhead: 0 }),
        ])}
        onRepositoryChange={() => undefined}
        workspaceId="ws_new"
      />,
    );

    expect(await screen.findByText("repo_new changes")).toBeVisible();
    await act(async () => {
      oldRequest.reject(new Error("The old request failed."));
      await oldRequest.promise.catch(() => undefined);
    });

    expect(fake.getWorkspaceRepositoryDiff).not.toHaveBeenCalledWith(
      "ws_old",
      "repo_old_two",
    );
    expect(screen.getByText("repo_new changes")).toBeVisible();
  });

  it("keeps review context in one compact toolbar without a second brief surface", async () => {
    const workspaceId = "ws_review_brief";
    const evidenceRequest = deferred<WorkspaceEvidence | null>();
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockImplementation(
      async (requestedWorkspaceId, repositoryId) =>
        repositoryDiff(requestedWorkspaceId, repositoryId),
    );
    fake.getWorkspaceEvidence.mockReturnValue(evidenceRequest.promise);
    const evidence = workspaceEvidenceFixture();

    render(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={materialization(workspaceId, [
          worktree("repo_changed", { changedFileCount: 1, commitsAhead: 0 }),
        ])}
        onRepositoryChange={() => undefined}
        workspaceId={workspaceId}
      />,
    );

    expect(await screen.findByText("repo_changed changes")).toBeVisible();
    expect(screen.getByTestId("repository-review-toolbar")).toBeVisible();
    expect(await screen.findByText("WTS checks review context")).toBeVisible();
    expect(screen.queryByLabelText("Agent review brief")).not.toBeInTheDocument();

    await act(async () => {
      evidenceRequest.resolve({
        ...evidence,
        agentReport: {
          ...evidence.agentReport,
          status: "ready",
          summary: "Review the retry boundary before the formatter change.",
          nextActions: [
            "Review the request retry state first.",
            "Should this fallback remain enabled for old clients?",
          ],
          findings: [
            {
              id: "retry-risk",
              title: "A retry can submit the request twice",
              detail: "The timeout branch retains the old request token.",
              severity: "warning",
              repositoryId: "repo_changed",
              evidence: ["src/repo_changed.ts:12"],
            },
          ],
        },
      });
      await evidenceRequest.promise;
    });

    expect(await screen.findByLabelText("1 reported risk")).toBeVisible();
    expect(screen.getByTestId("repository-review-toolbar")).toContainElement(
      screen.getByLabelText("1 reported risk"),
    );
    expect(screen.queryByText("Agent review brief")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show brief" })).not.toBeInTheDocument();
    expect(
      screen.queryByText("Review the request retry state first."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("A retry can submit the request twice"),
    ).not.toBeInTheDocument();

  });

  it("requests graph context only after the selected patch is visible", async () => {
    const workspaceId = "ws_lazy_graph";
    const patchRequest = deferred<WorkspaceRepositoryDiff>();
    const graphRequest = deferred<null>();
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockReturnValue(patchRequest.promise);
    fake.getWorkspaceRepositoryReviewGraph.mockReturnValue(graphRequest.promise);
    const readyMaterialization = {
      ...materialization(workspaceId, [
        worktree("repo_changed", { changedFileCount: 1, commitsAhead: 0 }),
      ]),
      graph: {
        status: "ready" as const,
        detail: "The graph is ready.",
      },
    };

    render(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={readyMaterialization}
        onRepositoryChange={() => undefined}
        workspaceId={workspaceId}
      />,
    );

    expect(fake.getWorkspaceRepositoryReviewGraph).not.toHaveBeenCalled();
    await act(async () => {
      patchRequest.resolve(repositoryDiff(workspaceId, "repo_changed"));
      await patchRequest.promise;
    });

    expect(await screen.findByText("repo_changed changes")).toBeVisible();
    expect(screen.getAllByText("src/repo_changed.ts")).not.toHaveLength(0);
    expect(fake.getWorkspaceRepositoryReviewGraph).toHaveBeenCalledWith(
      workspaceId,
      "repo_changed",
    );

    await act(async () => {
      graphRequest.resolve(null);
      await graphRequest.promise;
    });
  });

  it("keeps graph context returned with the patch without requesting it twice", async () => {
    const workspaceId = "ws_inline_graph";
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockResolvedValue({
      ...repositoryDiff(workspaceId, "repo_changed"),
      reviewGraph: {
        graphSha256: "sha256:inline-graph",
        nodes: [
          {
            id: "retry-request",
            label: "Retry request",
            sourceFile: "src/repo_changed.ts",
            sourceLocation: "src/repo_changed.ts:1",
          },
        ],
        links: [],
        truncated: false,
      },
    });

    render(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={{
          ...materialization(workspaceId, [
            worktree("repo_changed", { changedFileCount: 1, commitsAhead: 0 }),
          ]),
          graph: {
            status: "ready",
            detail: "The graph is ready.",
          },
        }}
        onRepositoryChange={() => undefined}
        workspaceId={workspaceId}
      />,
    );

    expect(await screen.findByText("repo_changed changes")).toBeVisible();
    expect(fake.getWorkspaceRepositoryReviewGraph).not.toHaveBeenCalled();
  });
});
