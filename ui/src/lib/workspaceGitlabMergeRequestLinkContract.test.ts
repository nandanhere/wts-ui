import { describe, expect, it, vi } from "vitest";
import { createWorkspaceClient, type GitlabMergeRequest, type WorkspaceClientOptions } from "./wtsClient";

const workspaceId = "workspace one/+";
const repositoryId = "repo one/+";
const iid = 43;
const linked: GitlabMergeRequest = {
  id: "mr-43",
  repositoryId,
  iid,
  projectPath: "sre-tools/senzu",
  webUrl: "https://gitlab.example.com/sre-tools/senzu/-/merge_requests/43",
  title: "Senzu flow",
  sourceBranch: "review/senzu-complete-flow",
  targetBranch: "develop",
  authorUsername: "user",
  updatedAt: "2026-09-22T12:00:00Z",
  draft: false,
  status: "open",
};

function transport(runtime: "http" | "tauri", response: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) =>
    new Response(JSON.stringify(String(url).endsWith("/bootstrap")
      ? { sessionToken: "session-123" }
      : response), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  const invoke = vi.fn(async () => response);
  const client = createWorkspaceClient({
    runtime,
    fetch,
    invoke: invoke as NonNullable<WorkspaceClientOptions["invoke"]>,
  });
  return { client, fetch, invoke };
}

describe.each(["http", "tauri"] as const)("Link an existing GitLab MR through %s", (runtime) => {
  it("posts the exact workspace and repository identity and returns the verified MR", async () => {
    const { client, fetch, invoke } = transport(runtime, linked);
    await expect(client.linkWorkspaceGitlabMergeRequest(workspaceId, repositoryId, iid))
      .resolves.toEqual(linked);
    if (runtime === "http") {
      expect(fetch).toHaveBeenLastCalledWith(
        "/api/v1/workspaces/workspace%20one%2F%2B/gitlab-merge-requests/repo%20one%2F%2B/43/link",
        expect.objectContaining({ method: "POST" }),
      );
      expect(invoke).not.toHaveBeenCalled();
    } else {
      expect(invoke).toHaveBeenCalledExactlyOnceWith(
        "link_workspace_gitlab_merge_request",
        { workspaceId, repositoryId, iid },
      );
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid IID %s before transport", async (invalidIid) => {
    const { client, fetch, invoke } = transport(runtime, linked);
    await expect(client.linkWorkspaceGitlabMergeRequest(workspaceId, repositoryId, invalidIid))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects an MR for another repository or IID", async () => {
    for (const response of [{ ...linked, repositoryId: "other" }, { ...linked, iid: 42 }]) {
      await expect(transport(runtime, response).client.linkWorkspaceGitlabMergeRequest(workspaceId, repositoryId, iid))
        .rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("rejects an untrusted URL and a malformed MR response", async () => {
    for (const response of [{ ...linked, webUrl: "javascript:alert(1)" }, { ...linked, status: "unknown" }]) {
      await expect(transport(runtime, response).client.linkWorkspaceGitlabMergeRequest(workspaceId, repositoryId, iid))
        .rejects.toMatchObject({ code: "invalid_response" });
    }
  });
});
