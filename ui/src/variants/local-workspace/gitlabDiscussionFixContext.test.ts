import { describe, expect, it } from "vitest";
import type { GitlabReviewDiscussion } from "../../lib/wtsClient";
import { buildGitlabDiscussionFixContext } from "./gitlabDiscussionFixContext";

const discussion: GitlabReviewDiscussion = {
  id: "original-thread", resolvable: true, resolved: false, automated: false,
  filePath: "src/retry.ts", side: "deletions", line: 12,
  position: { baseCommitOid: "a".repeat(40), startCommitOid: "b".repeat(40), headCommitOid: "c".repeat(40) },
  comments: [
    { id: 11, authorLogin: "priya", createdAt: "2026-09-18T09:00:00Z", body: "Check the old **retry branch**.\n\n```ts\nreturn retry();\n```" },
    { id: 12, authorLogin: "alex", createdAt: "2026-09-18T09:01:00Z", body: "Include the final failure case.\n\n<details>Preserve this source text.</details>" },
  ],
};
const source = {
  workspaceId: "ws_project", repositoryId: "worktree_checkout", providerRepositoryId: "gitlab_checkout", iid: 9,
  scopeId: "d".repeat(64), mergeRequestLabel: "team/checkout !9", title: "Fix retries", sourceBranch: "retry-fix", targetBranch: "main",
  discussion, fromCache: true, truncated: true, fetchedAtUnixMs: 100,
};

describe("GitLab discussion fix context", () => {
  it("serializes the complete conversation and original version with separate local and provider repository identities", () => {
    const context = buildGitlabDiscussionFixContext(source);
    expect(context).toBeDefined();
    expect(JSON.parse(JSON.stringify(context))).toEqual({
      kind: "gitlabDiscussion", workspaceId: "ws_project", repositoryId: "worktree_checkout", providerRepositoryId: "gitlab_checkout", iid: 9,
      scopeId: "d".repeat(64), discussionId: "original-thread", mergeRequestLabel: "team/checkout !9", title: "Fix retries", sourceBranch: "retry-fix", targetBranch: "main",
      filePath: "src/retry.ts", side: "deletions", line: 12, position: discussion.position,
      resolved: false, automated: false, comments: discussion.comments, fromCache: true, truncated: true, fetchedAtUnixMs: 100,
    });
    expect(context!.comments).not.toBe(discussion.comments);
    expect(context!.comments[0]).not.toBe(discussion.comments[0]);
    expect(context!.position).not.toBe(discussion.position);
    context!.comments[0]!.body = "Changed after handoff";
    context!.position!.headCommitOid = "e".repeat(40);
    expect(discussion.comments[0]!.body).toContain("old **retry branch**");
    expect(discussion.position!.headCommitOid).toBe("c".repeat(40));
  });

  it("does not invent a file or MR version for a general discussion", () => {
    const context = buildGitlabDiscussionFixContext({ ...source, discussion: { id: "general", resolvable: false, resolved: false, automated: true, comments: discussion.comments } });
    expect(context).toBeDefined();
    expect(context).not.toHaveProperty("filePath");
    expect(context).not.toHaveProperty("side");
    expect(context).not.toHaveProperty("line");
    expect(context).not.toHaveProperty("position");
    expect(context!.comments).toEqual(discussion.comments);
  });

  it.each([undefined, "", " "])("requires an explicit existing workspace identity (%s)", (workspaceId) => {
    expect(buildGitlabDiscussionFixContext({ ...source, workspaceId })).toBeUndefined();
  });
});
