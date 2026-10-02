import { describe, expect, it } from "vitest";
import {
  GET_GITLAB_MERGE_REQUESTS_TAURI_COMMAND,
  OPEN_GITLAB_MERGE_REQUEST_TAURI_COMMAND,
  gitlabMergeRequestInboxHttpPath,
  normalizeGitlabMergeRequestInbox,
  openGitlabMergeRequestHttpPath,
} from "./wtsClient";

describe("GitLab merge request transport contract", () => {
  it("normalizes a trusted GitLab URL for a direct merge-request link", () => {
    expect(
      normalizeGitlabMergeRequestInbox({
        schemaVersion: 1,
        state: "stale",
        mergeRequests: [
          {
            id: "gid://gitlab/MergeRequest/42",
            repositoryId: "repo_senzu",
            projectPath: "acme/senzu",
            webUrl: "https://gitlab.example.com/acme/senzu/-/merge_requests/42",
            iid: 42,
            title: "Validate admission",
            authorUsername: "octocat",
            sourceBranch: "feat/PLATFORM-7197",
            targetBranch: "develop",
            sourceHeadCommitOid: "0123456789abcdef0123456789abcdef01234567",
            updatedAt: "2026-08-14T08:15:00Z",
            draft: false,
            status: "merged",
          },
        ],
        fetchedAtUnixMs: 1_776_153_300_000,
        detail: "WTS shows saved GitLab merge requests.",
        diagnosticCode: "providerTimedOut",
      }),
    ).toMatchObject({
      state: "stale",
      mergeRequests: [{
        repositoryId: "repo_senzu",
        iid: 42,
        status: "merged",
        webUrl: "https://gitlab.example.com/acme/senzu/-/merge_requests/42",
      }],
      diagnosticCode: "providerTimedOut",
    });
  });

  it("keeps the HTTP and Tauri transport names stable", () => {
    expect(gitlabMergeRequestInboxHttpPath("workspace id")).toBe(
      "/api/v1/workspaces/workspace%20id/merge-requests/gitlab",
    );
    expect(openGitlabMergeRequestHttpPath("repo id", 42)).toBe(
      "/api/v1/repositories/repo%20id/merge-requests/gitlab/42/open",
    );
    expect(GET_GITLAB_MERGE_REQUESTS_TAURI_COMMAND).toBe(
      "get_gitlab_merge_requests",
    );
    expect(OPEN_GITLAB_MERGE_REQUEST_TAURI_COMMAND).toBe(
      "open_gitlab_merge_request",
    );
  });

  it("rejects unsafe provider URLs and unknown fields", () => {
    expect(() =>
      normalizeGitlabMergeRequestInbox({
        schemaVersion: 1,
        state: "fresh",
        mergeRequests: [{
          id: "mr-42",
          repositoryId: "repo_senzu",
          projectPath: "acme/senzu",
          webUrl: "javascript:alert(1)",
          iid: 42,
          title: "Validate admission",
          authorUsername: "octocat",
          sourceBranch: "feat/PLATFORM-7197",
          targetBranch: "develop",
          updatedAt: "2026-08-14T08:15:00Z",
          draft: false,
          status: "open",
          unexpected: true,
        }],
        fetchedAtUnixMs: 1_776_153_300_000,
        detail: "Current merge requests.",
      }),
    ).toThrow(/invalid/i);
  });

  it("rejects malformed commit IDs and oversized provider arrays", () => {
    const mergeRequest = {
      id: "mr-42",
      repositoryId: "repo_senzu",
      projectPath: "acme/senzu",
      webUrl: "https://gitlab.example.com/acme/senzu/-/merge_requests/42",
      iid: 42,
      title: "Validate admission",
      authorUsername: "octocat",
      sourceBranch: "feat/PLATFORM-7197",
      targetBranch: "develop",
      updatedAt: "2026-08-14T08:15:00Z",
      draft: false,
      status: "open",
    };
    const inbox = (mergeRequests: unknown[]) => ({
      schemaVersion: 1,
      state: "fresh",
      mergeRequests,
      fetchedAtUnixMs: 1_776_153_300_000,
      detail: "Current merge requests.",
    });

    expect(() =>
      normalizeGitlabMergeRequestInbox(inbox([{
        ...mergeRequest,
        sourceHeadCommitOid: "not-a-commit-id",
      }])),
    ).toThrow(/invalid/i);
    expect(() =>
      normalizeGitlabMergeRequestInbox(
        inbox(Array.from({ length: 51 }, (_, iid) => ({
          ...mergeRequest,
          id: `mr-${iid + 1}`,
          iid: iid + 1,
        }))),
      ),
    ).toThrow(/invalid/i);
  });
});
