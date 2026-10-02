import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceClient,
  type GitlabDiscussionReplyRequest,
  type GitlabDiscussionReplyResult,
  type GitlabDiscussions,
  type WorkspaceClientOptions,
} from "./wtsClient";

const repositoryId = "repo one/+";
const iid = 73;
const discussionId = "thread_1";
const workspaceId = "workspace one/+";
const comment = {
  id: 91,
  body: "Keep the retry limit.",
  authorLogin: "priya",
  createdAt: "2026-09-17T08:15:00Z",
};

function snapshot(): GitlabDiscussions {
  return {
    schemaVersion: 1,
    repositoryId,
    iid,
    scopeId: "a".repeat(64),
    viewerLogin: "nandan",
    discussions: [{
      id: discussionId,
      resolvable: true,
      resolved: false,
      automated: false,
      filePath: "src/retry.ts",
      side: "additions",
      line: 12,
      comments: [{ ...comment }],
    }],
    fetchedAtUnixMs: 1_789_632_900_000,
    fromCache: false,
    truncated: false,
  };
}

function replyResult(): GitlabDiscussionReplyResult {
  return { schemaVersion: 1, repositoryId, iid, discussionId, comment: { ...comment } };
}

function transport(runtime: "http" | "tauri", result: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) =>
    new Response(JSON.stringify(String(url).endsWith("/bootstrap")
      ? { sessionToken: "session-123" }
      : result), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  const invoke = vi.fn(async () => result);
  const client = createWorkspaceClient({
    runtime,
    fetch,
    invoke: invoke as NonNullable<WorkspaceClientOptions["invoke"]>,
  });
  return { client, fetch, invoke };
}

const requestHeaders = {
  Accept: "application/json",
  "X-WTS-Session": "session-123",
  "X-WTS-Request": "local-ui",
};

describe.each(["http", "tauri"] as const)("GitLab discussions through %s", (runtime) => {
  it("reads the exact MR and optional workspace through the authenticated transport", async () => {
    const result = snapshot();
    const { client, fetch, invoke } = transport(runtime, result);
    await expect(client.getGitlabDiscussions(repositoryId, iid, workspaceId)).resolves.toEqual(result);
    await expect(client.getGitlabDiscussions(repositoryId, iid)).resolves.toEqual(result);
    if (runtime === "http") {
      expect(fetch.mock.calls).toEqual([
        ["/api/v1/bootstrap", { method: "GET", headers: { Accept: "application/json", "X-WTS-Request": "local-ui" } }],
        ["/api/v1/reviews/gitlab/repo%20one%2F%2B/73/discussions?workspaceId=workspace%20one%2F%2B", { headers: requestHeaders }],
        ["/api/v1/reviews/gitlab/repo%20one%2F%2B/73/discussions", { headers: requestHeaders }],
      ]);
      expect(invoke).not.toHaveBeenCalled();
    } else {
      expect(invoke.mock.calls).toEqual([
        ["get_gitlab_discussions", { repositoryId, iid, workspaceId }],
        ["get_gitlab_discussions", { repositoryId, iid }],
      ]);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("preserves cached and truncated snapshots without claiming fresh complete data", async () => {
    const result = { ...snapshot(), fromCache: true, truncated: true };
    await expect(transport(runtime, result).client.getGitlabDiscussions(repositoryId, iid)).resolves.toEqual(result);
  });

  it("replies to the exact discussion and preserves the comment text", async () => {
    const result = replyResult();
    const { client, fetch, invoke } = transport(runtime, result);
    const request = { discussionId, body: "  Agreed.\nI will keep the limit.  ", workspaceId };
    await expect(client.replyGitlabDiscussion(repositoryId, iid, request)).resolves.toEqual(result);
    if (runtime === "http") {
      expect(fetch.mock.calls[1]).toEqual([
        "/api/v1/reviews/gitlab/repo%20one%2F%2B/73/discussions/reply",
        { method: "POST", headers: { ...requestHeaders, "Content-Type": "application/json" }, body: JSON.stringify(request) },
      ]);
      expect(invoke).not.toHaveBeenCalled();
    } else {
      expect(invoke.mock.calls).toEqual([["reply_gitlab_discussion", { repositoryId, iid, request }]]);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("accepts the full Unicode character limit for replies", async () => {
    const { client } = transport(runtime, replyResult());
    await expect(client.replyGitlabDiscussion(repositoryId, iid, {
      discussionId, body: "😀".repeat(16_384),
    })).resolves.toEqual(replyResult());
  });

  it.each([
    ["another repository", { repositoryId: "repo_other" }],
    ["another MR", { iid: 74 }],
    ["zero MR", { iid: 0 }],
    ["unsafe numeric MR", { iid: Number.MAX_SAFE_INTEGER + 1 }],
    ["unknown schema", { schemaVersion: 2 }],
    ["unknown field", { providerUrl: "https://example.test" }],
    ["empty scope", { scopeId: "" }],
    ["malformed scope", { scopeId: "not-a-scope" }],
    ["empty viewer", { viewerLogin: " " }],
    ["unsafe viewer", { viewerLogin: "user/name" }],
    ["oversized viewer", { viewerLogin: "a".repeat(256) }],
    ["negative time", { fetchedAtUnixMs: -1 }],
    ["non-boolean cache", { fromCache: "false" }],
    ["non-boolean truncation", { truncated: 0 }],
    ["non-array discussions", { discussions: {} }],
  ])("rejects a snapshot with %s", async (_label, changes) => {
    const { client } = transport(runtime, { ...snapshot(), ...changes });
    await expect(client.getGitlabDiscussions(repositoryId, iid)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each(["", "../thread", "thread/id", "thread%2fid", "a".repeat(129)])("rejects unsafe discussion ID %j in a snapshot", async (id) => {
    const result = snapshot();
    result.discussions[0]!.id = id;
    await expect(transport(runtime, result).client.getGitlabDiscussions(repositoryId, iid)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    ["zero ID", { id: 0 }],
    ["unsafe numeric ID", { id: Number.MAX_SAFE_INTEGER + 1 }],
    ["empty body", { body: "" }],
    ["oversized body", { body: "x".repeat(16_385) }],
    ["NUL body", { body: "a\0b" }],
    ["empty author", { authorLogin: " " }],
    ["empty timestamp", { createdAt: "" }],
    ["unknown field", { url: "https://example.test" }],
  ])("rejects a discussion comment with %s", async (_label, changes) => {
    const result = snapshot();
    result.discussions[0]!.comments[0] = { ...comment, ...changes };
    await expect(transport(runtime, result).client.getGitlabDiscussions(repositoryId, iid)).rejects.toMatchObject({ code: "invalid_response" });
    await expect(transport(runtime, { ...replyResult(), comment: { ...comment, ...changes } }).client.replyGitlabDiscussion(repositoryId, iid, {
      discussionId, body: "Agreed.",
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects excess discussions and comments across multiple threads", async () => {
    const result = snapshot();
    const discussion = result.discussions[0]!;
    result.discussions = Array.from({ length: 101 }, (_, index) => ({ ...discussion, id: `thread_${index}`, comments: [] }));
    await expect(transport(runtime, result).client.getGitlabDiscussions(repositoryId, iid)).rejects.toMatchObject({ code: "invalid_response" });
    result.discussions = [100, 101].map((count, index) => ({
      ...discussion, id: `thread_${index}`,
      comments: Array.from({ length: count }, (_, note) => ({ ...comment, id: index * 100 + note + 1 })),
    }));
    await expect(transport(runtime, result).client.getGitlabDiscussions(repositoryId, iid)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    { repositoryId: "repo_other" },
    { iid: 74 },
    { discussionId: "another_thread" },
    { discussionId: "../thread" },
    { schemaVersion: 2 },
    { accepted: true },
  ])("rejects a mismatched or malformed reply result %j", async (changes) => {
    const { client } = transport(runtime, { ...replyResult(), ...changes });
    await expect(client.replyGitlabDiscussion(repositoryId, iid, { discussionId, body: "Agreed." })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    { discussionId: "" },
    { discussionId: "../thread" },
    { discussionId: "a".repeat(129) },
    { body: " " },
    { body: "a\0b" },
    { body: "x".repeat(16_385) },
    { body: null },
    { workspaceId: " " },
    { providerUrl: "https://example.test" },
  ])("rejects a malformed reply request before transport %j", async (changes) => {
    const { client, fetch, invoke } = transport(runtime, replyResult());
    await expect(client.replyGitlabDiscussion(repositoryId, iid, {
      discussionId, body: "Agreed.", ...changes,
    } as GitlabDiscussionReplyRequest)).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects invalid read and reply identities before transport", async () => {
    const { client, fetch, invoke } = transport(runtime, snapshot());
    await expect(client.getGitlabDiscussions(" ", iid)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.getGitlabDiscussions(repositoryId, 0)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.getGitlabDiscussions(repositoryId, iid, " ")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.replyGitlabDiscussion(repositoryId, 0, { discussionId, body: "Agreed." })).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
