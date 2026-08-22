import { describe, expect, it } from "vitest";
import {
  GITHUB_REVIEW_INBOX_HTTP_PATH,
  GITHUB_REVIEW_INBOX_TAURI_COMMAND,
  normalizeGithubReviewInbox,
  openGithubReviewHttpPath,
} from "./wtsClient";

describe("GitHub review transport contract", () => {
  it("normalizes the exact Rust inbox shape", () => {
    expect(normalizeGithubReviewInbox({
      schemaVersion: 1,
      state: "stale",
      reviews: [{
        id: "PR_42",
        repositoryId: "repo_api",
        repository: "acme/api",
        number: 42,
        title: "Bound retries",
        url: "https://github.com/acme/api/pull/42",
        authorLogin: "octocat",
        updatedAt: "2026-08-14T08:15:00Z",
        draft: false,
      }],
      fetchedAtUnixMs: 1_776_153_300_000,
      detail: "WTS shows saved review data.",
      diagnosticCode: "providerTimedOut",
    })).toMatchObject({
      state: "stale",
      reviews: [{ repository: "acme/api", number: 42 }],
      diagnosticCode: "providerTimedOut",
    });
  });

  it("keeps the host transport names isolated", () => {
    expect(GITHUB_REVIEW_INBOX_HTTP_PATH).toBe("/api/v1/reviews/github");
    expect(GITHUB_REVIEW_INBOX_TAURI_COMMAND).toBe("get_github_review_inbox");
    expect(openGithubReviewHttpPath("repo_api", 42)).toBe(
      "/api/v1/reviews/github/repo_api/42/open",
    );
  });

  it("rejects browser-authoritative URLs", () => {
    expect(() => normalizeGithubReviewInbox({
      schemaVersion: 1,
      state: "fresh",
      reviews: [{
        id: "PR_42",
        repositoryId: "repo_api",
        repository: "acme/api",
        number: 42,
        title: "Bound retries",
        url: "javascript:alert(1)",
        authorLogin: "octocat",
        updatedAt: "2026-08-14T08:15:00Z",
        draft: false,
      }],
      fetchedAtUnixMs: 1_776_153_300_000,
      detail: "Current reviews.",
    })).toThrow(/invalid/i);
  });
});
