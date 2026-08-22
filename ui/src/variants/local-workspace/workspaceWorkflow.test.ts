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
      repositoryId: "repo_apex_api",
      repository: "devtools/apex-api",
      number: 9,
      title: "Validate the LogQL time range",
      authorLogin: "dave",
      sourceBranch: "DEVTOOLS-6349",
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
        label: "Review devtools/apex-api !9",
      },
      repositoryPlans: [{
        repositoryId: "repo_apex_api",
        baseRef: "DEVTOOLS-6349",
      }],
    };

    expect(gitlabReviewForWorkspace(workspace, [review])).toEqual(review);
    expect(
      gitlabReviewForWorkspace(
        {
          ...workspace,
          intent: {
            type: "repositorySet",
            label: "Local repositories · apex-api",
          },
          title: "Review devtools/apex-api !9",
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
            label: "Local repositories · apex-api",
          },
          title: "Review devtools/apex-api !9",
          repositoryPlans: [{
            repositoryId: "local_clone_apex_api",
            label: "apex-api",
            baseRef: "DEVTOOLS-6349",
          }],
        },
        [],
      ),
    ).toEqual({
      repositoryId: "local_clone_apex_api",
      repository: "devtools/apex-api",
      number: 9,
    });
    expect(
      gitlabReviewForWorkspace(
        {
          ...workspace,
          repositoryPlans: [{
            repositoryId: "local_clone_apex_api",
            label: "apex-api",
            baseRef: "DEVTOOLS-6349",
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
            repositoryId: "repo_apex_api",
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
