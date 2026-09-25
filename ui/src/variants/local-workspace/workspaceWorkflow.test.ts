import { describe, expect, it } from "vitest";
import {
  gitlabReviewForWorkspace,
  gitlabReviewTargetForWorkspace,
  laneForWorkflowState,
  markWorkspaceWorkflowSignalHandled,
  suggestedWorkflowState,
  suggestedWorkflowStateForGitlabReview,
  suggestedWorkflowStateForMergeRequests,
  workspaceWorkflowSignalHandled,
  workflowStateForLane,
} from "./workspaceWorkflow";

describe("workspace workflow projection", () => {
  it("maps every durable state to the matching visible lane", () => {
    expect(laneForWorkflowState("ready")).toBe("planned");
    expect(laneForWorkflowState("active")).toBe("active");
    expect(laneForWorkflowState("review")).toBe("attention");
    expect(laneForWorkflowState("parked")).toBe("suspended");
    expect(workflowStateForLane("attention")).toBe("review");
  });

  it("moves active and completed agent work into review-loop states", () => {
    expect(
      suggestedWorkflowState("ready", { state: "working" }),
    ).toBe("active");
    expect(
      suggestedWorkflowState("active", {
        state: "idle",
        updateKind: "completion",
      }),
    ).toBe("review");
    expect(
      suggestedWorkflowState("active", { state: "attention" }),
    ).toBe("review");
  });

  it("does not unpark a workspace or infer completion from plain idle state", () => {
    expect(
      suggestedWorkflowState("parked", { state: "working" }),
    ).toBeNull();
    expect(suggestedWorkflowState("active", { state: "idle" })).toBeNull();
  });

  it("can apply current agent activity after a user follows a parked workspace", () => {
    expect(
      suggestedWorkflowState(
        "parked",
        { state: "working" },
        { allowUnpark: true },
      ),
    ).toBe("active");
  });

  it("maps fresh merge request state to the durable board workflow", () => {
    expect(
      suggestedWorkflowStateForMergeRequests("review", [
        { status: "open", updatedAt: "2026-08-17T10:00:00Z" },
        { status: "closed", updatedAt: "2026-08-17T11:00:00Z" },
      ]),
    ).toBe("parked");
    expect(
      suggestedWorkflowStateForMergeRequests("parked", [
        { status: "merged", updatedAt: "2026-08-17T12:00:00Z" },
      ]),
    ).toBe("review");
    expect(
      suggestedWorkflowStateForMergeRequests("parked", [
        { status: "closed", updatedAt: "2026-08-17T13:00:00Z" },
      ]),
    ).toBe("active");
    expect(suggestedWorkflowStateForMergeRequests("active", [])).toBeNull();
  });

  it("parks only the exact saved review workspace after approval", () => {
    const review = {
      id: "887185",
      repositoryId: "repo_obx_api",
      repository: "sre-tools/obx-api",
      number: 9,
      title: "Validate the LogQL time range",
      authorLogin: "priya",
      sourceBranch: "SRETOOLS-6349",
      targetBranch: "develop",
      updatedAt: "2026-08-18T05:05:48Z",
      draft: false,
      reviewState: "approved" as const,
      status: "open" as const,
      commentCount: 1,
    };
    const workspace = {
      intent: {
        type: "repositorySet" as const,
        label: "Review sre-tools/obx-api !9",
      },
      repositoryPlans: [{
        repositoryId: "repo_obx_api",
        baseRef: "SRETOOLS-6349",
      }],
    };

    expect(gitlabReviewForWorkspace(workspace, [review])).toEqual(review);
    // Real review workspaces keep a short label and a full-path title.
    expect(
      gitlabReviewForWorkspace(
        {
          ...workspace,
          intent: { type: "repositorySet", label: "Review obx-api !9" },
          title: "Review sre-tools/obx-api !9",
        },
        [review],
      ),
    ).toEqual(review);
    expect(
      gitlabReviewForWorkspace(
        {
          ...workspace,
          intent: {
            type: "repositorySet",
            label: "Local repositories · obx-api",
          },
          title: "Review sre-tools/obx-api !9",
        },
        [review],
      ),
    ).toEqual(review);
    expect(
      gitlabReviewTargetForWorkspace(
        {
          ...workspace,
          intent: {
            type: "repositorySet",
            label: "Local repositories · obx-api",
          },
          title: "Review sre-tools/obx-api !9",
          repositoryPlans: [{
            repositoryId: "local_clone_obx_api",
            label: "obx-api",
            baseRef: "SRETOOLS-6349",
          }],
        },
        [],
      ),
    ).toEqual({
      repositoryId: "local_clone_obx_api",
      repository: "sre-tools/obx-api",
      number: 9,
    });
    expect(
      gitlabReviewTargetForWorkspace(
        {
          ...workspace,
          intent: { type: "repositorySet", label: "Local repositories · obx-api" },
          title: "Review sre-tools/obx-api !9",
          repositoryPlans: [{ repositoryId: "local_clone_obx_api", label: "obx-api", baseRef: "SRETOOLS-6349" }],
        },
        [],
        [
          { id: "8", repositoryId: "local_clone_obx_api", projectPath: "sre-tools/obx-api", webUrl: "https://gitlab.example/8", iid: 8, title: "Other", sourceBranch: "x", targetBranch: "main", authorUsername: "ana", updatedAt: "2026-09-01T00:00:00Z", draft: false, status: "open" },
          { id: "9", repositoryId: "local_clone_obx_api", projectPath: "sre-tools/obx-api", webUrl: "https://gitlab.example/9", iid: 9, title: "Add retries", sourceBranch: "SRETOOLS-6349", targetBranch: "main", authorUsername: "ana", updatedAt: "2026-09-02T00:00:00Z", draft: false, status: "merged" },
        ],
      ),
    ).toMatchObject({ number: 9, status: "merged", title: "Add retries" });
    expect(
      gitlabReviewForWorkspace(
        {
          ...workspace,
          repositoryPlans: [{
            repositoryId: "local_clone_obx_api",
            label: "obx-api",
            baseRef: "SRETOOLS-6349",
          }],
        },
        [review],
      ),
    ).toEqual(review);
    expect(suggestedWorkflowStateForGitlabReview("review", review)).toBe(
      "parked",
    );
    expect(
      gitlabReviewForWorkspace(
        {
          ...workspace,
          repositoryPlans: [{
            repositoryId: "repo_obx_api",
            baseRef: "develop",
          }],
        },
        [review],
      ),
    ).toBeUndefined();
    expect(
      suggestedWorkflowStateForGitlabReview("review", {
        ...review,
        reviewState: "requested",
      }),
    ).toBeNull();
    expect(
      suggestedWorkflowStateForGitlabReview("ready", {
        ...review,
        reviewState: "requested",
      }),
    ).toBe("review");
    expect(
      suggestedWorkflowStateForGitlabReview("parked", {
        ...review,
        reviewState: "changesAfterApproval",
      }),
    ).toBe("review");
  });

  it("remembers an applied agent signal across refreshes", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(workspaceWorkflowSignalHandled("workspace-1", 100, storage)).toBe(
      false,
    );
    expect(
      markWorkspaceWorkflowSignalHandled("workspace-1", 100, storage),
    ).toBe(true);
    expect(workspaceWorkflowSignalHandled("workspace-1", 100, storage)).toBe(
      true,
    );
    expect(workspaceWorkflowSignalHandled("workspace-1", 101, storage)).toBe(
      false,
    );
  });
});
