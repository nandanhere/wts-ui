import { describe, expect, it } from "vitest";
import {
  GITLAB_REVIEW_INBOX_HTTP_PATH,
  GITLAB_REVIEW_INBOX_TAURI_COMMAND,
  PREPARE_GITLAB_REVIEW_REPOSITORY_TAURI_COMMAND,
  normalizeGitlabReviewInbox,
  normalizeGitlabReviewPatch,
  prepareGitlabReviewRepositoryHttpPath,
} from "./wtsClient";

describe("GitLab assigned review contract", () => {
  it("accepts the bounded server-owned inbox without provider URLs", () => {
    expect(normalizeGitlabReviewInbox({
      schemaVersion: 1,
      state: "fresh",
      reviews: [{
        id: "gid://gitlab/MergeRequest/73",
        repositoryId: "repo_senzu",
        repository: "acme/senzu",
        number: 73,
        title: "Keep workspace removal recoverable",
        authorLogin: "nandan",
        sourceBranch: "feat/removal",
        targetBranch: "develop",
        headCommitOid: "c".repeat(40),
        updatedAt: "2026-08-17T08:15:00Z",
        draft: false,
        reviewState: "approved",
        status: "open",
        commentCount: 4,
        discussionsResolved: false,
      }],
      fetchedAtUnixMs: 1_776_412_500_000,
      detail: "GitLab returned the current individual review requests.",
    })).toMatchObject({
      state: "fresh",
      reviews: [{
        repositoryId: "repo_senzu",
        number: 73,
        reviewState: "approved",
        status: "open",
        headCommitOid: "c".repeat(40),
        commentCount: 4,
        discussionsResolved: false,
      }],
    });
    expect(GITLAB_REVIEW_INBOX_HTTP_PATH).toBe("/api/v1/reviews/gitlab");
    expect(GITLAB_REVIEW_INBOX_TAURI_COMMAND).toBe("get_gitlab_review_inbox");
    expect(prepareGitlabReviewRepositoryHttpPath("repo id", 73)).toBe(
      "/api/v1/reviews/gitlab/repo%20id/73/prepare-repository",
    );
    expect(PREPARE_GITLAB_REVIEW_REPOSITORY_TAURI_COMMAND).toBe(
      "prepare_gitlab_review_repository",
    );
  });

  it("rejects provider URLs and unknown review fields", () => {
    expect(() => normalizeGitlabReviewInbox({
      schemaVersion: 1,
      state: "fresh",
      reviews: [{
        id: "73",
        repositoryId: "repo_senzu",
        repository: "acme/senzu",
        number: 73,
        title: "Review this",
        authorLogin: "nandan",
        sourceBranch: "feat/review",
        targetBranch: "develop",
        updatedAt: "2026-08-17T08:15:00Z",
        draft: false,
        reviewState: "requested",
        status: "open",
        webUrl: "https://gitlab.example.com/acme/senzu/-/merge_requests/73",
      }],
      fetchedAtUnixMs: 1,
      detail: "Current reviews.",
    })).toThrow(/invalid/i);
  });

  it("accepts a provider-confirmed change after approval", () => {
    expect(normalizeGitlabReviewInbox({
      schemaVersion: 1,
      state: "fresh",
      reviews: [{
        id: "gid://gitlab/MergeRequest/74",
        repositoryId: "repo_senzu",
        repository: "acme/senzu",
        number: 74,
        title: "Refactor logging after review",
        authorLogin: "priya",
        sourceBranch: "feat/logging",
        targetBranch: "develop",
        headCommitOid: "d".repeat(40),
        updatedAt: "2026-08-19T08:15:00Z",
        draft: false,
        reviewState: "changesAfterApproval",
        status: "open",
        commentCount: 1,
        discussionsResolved: true,
      }],
      fetchedAtUnixMs: 1_776_585_300_000,
      detail: "GitLab found a new commit after the current user's approval.",
    }).reviews[0]?.reviewState).toBe("changesAfterApproval");
  });

  it("accepts a bounded merge request commit list", () => {
    const oid = "d".repeat(40);
    expect(normalizeGitlabReviewPatch({
      schemaVersion: 1,
      repositoryId: "repo_senzu",
      iid: 74,
      baseCommitOid: "a".repeat(40),
      startCommitOid: "b".repeat(40),
      headCommitOid: "c".repeat(40),
      selectedCommitOid: oid,
      commits: [{
        oid,
        parentOid: "c".repeat(40),
        shortId: "dddddddd",
        title: "Refactor logging",
        authorName: "Priya",
        authoredAt: "2026-08-19T08:15:00Z",
      }],
      discussions: [{
        id: "discussion-1",
        resolvable: true,
        resolved: false,
        automated: false,
        filePath: "log.ts",
        side: "additions",
        line: 12,
        comments: [{
          id: 91,
          body: "Can this be configuration driven?",
          authorLogin: "nandan",
          createdAt: "2026-08-19T08:16:00Z",
        }],
      }],
      patch: "diff --git a/log.ts b/log.ts\n--- a/log.ts\n+++ b/log.ts\n",
      patchTruncated: false,
      fromCache: true,
      fetchedAtUnixMs: 1_787_221_345_000,
    })).toMatchObject({
      selectedCommitOid: oid,
      commits: [{ oid }],
      discussions: [{ filePath: "log.ts", comments: [{ authorLogin: "nandan" }] }],
    });
  });
});
