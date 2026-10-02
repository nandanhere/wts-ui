import { describe, expect, it } from "vitest";
import type { GitlabReviewInbox } from "../../lib/wtsClient";
import { reconcileGitlabReviewContinuity } from "./gitlabReviewContinuity";

const oldHead = "a".repeat(40);
const newHead = "b".repeat(40);

function inbox(
  headCommitOid: string,
  reviewState: "requested" | "approved",
): GitlabReviewInbox {
  return {
    schemaVersion: 1,
    state: "fresh",
    reviews: [{
      id: "mr-9",
      repositoryId: "repo_obx_api",
      repository: "sre-tools/obx-api",
      number: 9,
      title: "Validate the LogQL time range",
      authorLogin: "priya",
      sourceBranch: "SRETOOLS-6349",
      targetBranch: "develop",
      headCommitOid,
      updatedAt: "2026-08-19T08:00:00Z",
      draft: false,
      reviewState,
      status: "open",
    }],
    fetchedAtUnixMs: 1,
    detail: "GitLab returned current reviews.",
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("GitLab review continuity", () => {
  it("returns a new head to review after the user approved the old head", () => {
    const storage = memoryStorage();
    reconcileGitlabReviewContinuity(inbox(oldHead, "approved"), storage);

    expect(
      reconcileGitlabReviewContinuity(inbox(newHead, "requested"), storage)
        .reviews[0]?.reviewState,
    ).toBe("changesAfterApproval");
  });

  it("accepts the new head as the baseline after GitLab reports a new approval", () => {
    const storage = memoryStorage();
    reconcileGitlabReviewContinuity(inbox(oldHead, "approved"), storage);
    reconcileGitlabReviewContinuity(inbox(newHead, "requested"), storage);

    expect(
      reconcileGitlabReviewContinuity(inbox(newHead, "approved"), storage)
        .reviews[0]?.reviewState,
    ).toBe("approved");
  });
});
