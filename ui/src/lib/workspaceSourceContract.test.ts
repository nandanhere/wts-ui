import { describe, expect, it, vi } from "vitest";
import { createWorkspaceClient, type WorkspaceClientOptions } from "./wtsClient";

const workspaceId = "workspace one/+";
const repositoryId = "repo one/+";
const filePath = "src/a & b.ts";
const iid = 16;
const base = "a".repeat(40);
const head = "b".repeat(40);
const localHead = "c".repeat(40);
const revision = `sha256:${"d".repeat(64)}`;
const source = () => ({ schemaVersion: 1, workspaceId, repositoryId, filePath, content: "original\r\n", revision });
const diff = (baseCommitOid: string) => ({ schemaVersion: 1, workspaceId, repositoryId, repositoryLabel: "api", baseCommitOid, headCommitOid: localHead, patchSha256: revision, patch: "local patch", patchTruncated: false, untrackedPaths: ["new.ts"], untrackedPathsTruncated: false });
const comparison = () => ({
  schemaVersion: 1, workspaceId, repositoryId, repositoryLabel: "api", iid,
  localHeadCommitOid: localHead, status: "ready",
  published: { schemaVersion: 1, repositoryId, iid, baseCommitOid: base, startCommitOid: base, headCommitOid: head, commits: [], discussions: [], patch: "published patch", patchTruncated: false, fromCache: false, fetchedAtUnixMs: 1 },
  latestWork: diff(base), sinceMr: diff(head),
});

function transport(runtime: "http" | "tauri", payload: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => new Response(JSON.stringify(String(url).endsWith("/bootstrap") ? { sessionToken: "session" } : payload), { status: 200 }));
  const invoke = vi.fn(async () => payload);
  const client = createWorkspaceClient({ runtime, fetch, invoke: invoke as NonNullable<WorkspaceClientOptions["invoke"]> });
  return { client, fetch, invoke };
}

describe.each(["http", "tauri"] as const)("MR comparisons and local source through %s", (runtime) => {
  it("gets one complete comparison with explicit refresh and exact transport scope", async () => {
    const { client, fetch, invoke } = transport(runtime, comparison());
    await expect(client.getWorkspaceGitlabComparison(workspaceId, repositoryId, iid, true)).resolves.toEqual(comparison());
    if (runtime === "http") expect(fetch).toHaveBeenLastCalledWith(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/gitlab/16/comparison?refresh=true`, expect.objectContaining({ headers: expect.objectContaining({ "X-WTS-Session": "session" }) }));
    else expect(invoke).toHaveBeenCalledWith("get_workspace_gitlab_comparison", { workspaceId, repositoryId, iid, refresh: true });
  });

  it("gets the exact current file with a revision for editing", async () => {
    const { client, fetch, invoke } = transport(runtime, source());
    await expect(client.getWorkspaceRepositorySource(workspaceId, repositoryId, filePath)).resolves.toEqual(source());
    if (runtime === "http") expect(fetch).toHaveBeenLastCalledWith(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/source?filePath=${encodeURIComponent(filePath)}`, expect.anything());
    else expect(invoke).toHaveBeenCalledWith("get_workspace_repository_source", { workspaceId, repositoryId, filePath });
  });

  it("retains the original published version of a discussion", async () => {
    const position = { baseCommitOid: base, startCommitOid: base, headCommitOid: head };
    const payload = comparison();
    const discussion = { id: "thread", resolvable: true, resolved: false, automated: false, filePath, side: "additions", line: 1, position, comments: [{ id: 1, body: "Please edit this.", authorLogin: "reviewer", createdAt: "2026-09-17T08:00:00Z" }] };
    const { client } = transport(runtime, { ...payload, published: { ...payload.published, discussions: [discussion] } });
    await expect(client.getWorkspaceGitlabComparison(workspaceId, repositoryId, iid)).resolves.toMatchObject({ published: { discussions: [{ position }] } });
  });

  it("sends published line comments with the selected workspace and displayed MR version", async () => {
    const result = { schemaVersion: 1, repositoryId, iid, accepted: true };
    const { client, fetch, invoke } = transport(runtime, result);
    const request = { body: "Please check this line.", filePath, side: "additions" as const, line: 1, workspaceId, expectedPosition: { baseCommitOid: base, startCommitOid: base, headCommitOid: head } };
    await expect(client.publishGitlabReviewComment(repositoryId, iid, request)).resolves.toEqual(result);
    if (runtime === "http") expect(fetch).toHaveBeenLastCalledWith(`/api/v1/reviews/gitlab/${encodeURIComponent(repositoryId)}/${iid}/comments`, expect.objectContaining({ method: "POST", body: JSON.stringify(request) }));
    else expect(invoke).toHaveBeenCalledWith("publish_gitlab_review_comment", { repositoryId, iid, request });
  });

  it("saves the exact content once with the displayed revision", async () => {
    const content = "  const emoji = '😀';\r\n\n";
    const { client, fetch, invoke } = transport(runtime, { ...source(), content });
    const request = { filePath, content, expectedRevision: revision };
    await expect(client.saveWorkspaceRepositorySource(workspaceId, repositoryId, request)).resolves.toMatchObject({ content });
    if (runtime === "http") {
      expect(fetch).toHaveBeenLastCalledWith(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/source`, expect.objectContaining({ method: "PUT", body: JSON.stringify(request) }));
      expect(fetch.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    } else {
      expect(invoke).toHaveBeenCalledExactlyOnceWith("save_workspace_repository_source", { workspaceId, repositoryId, request });
    }
  });

  it("preserves a revision conflict and does not retry the write", async () => {
    const { client, fetch, invoke } = transport(runtime, source());
    const error = { code: "repository_file_conflict", message: "The file changed. Reload it before saving.", retryable: false };
    if (runtime === "http") fetch.mockImplementation(async (url) => new Response(JSON.stringify(String(url).endsWith("/bootstrap") ? { sessionToken: "session" } : { error }), { status: String(url).endsWith("/bootstrap") ? 200 : 409 }));
    else invoke.mockRejectedValue(error);
    await expect(client.saveWorkspaceRepositorySource(workspaceId, repositoryId, { filePath, content: "new", expectedRevision: revision })).rejects.toMatchObject(error);
    expect(runtime === "http" ? fetch.mock.calls.filter(([, init]) => init?.method === "PUT").length : invoke.mock.calls.length).toBe(1);
  });

  it("rejects a save acknowledgement that contains another file revision's content", async () => {
    const { client, fetch, invoke } = transport(runtime, { ...source(), content: "old response" });
    await expect(client.saveWorkspaceRepositorySource(workspaceId, repositoryId, { filePath, content: "my unsaved work", expectedRevision: revision })).rejects.toMatchObject({ code: "invalid_response" });
    expect(runtime === "http" ? fetch.mock.calls.filter(([, init]) => init?.method === "PUT").length : invoke.mock.calls.length).toBe(1);
  });

  it.each(["../outside", "/absolute", "a/../b", "a\\b", ".git/config", "a/.git/config", "a\0b"])("rejects unsafe source path %j before transport", async (path) => {
    const { client, fetch, invoke } = transport(runtime, source());
    await expect(client.getWorkspaceRepositorySource(workspaceId, repositoryId, path)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.saveWorkspaceRepositorySource(workspaceId, repositoryId, { filePath: path, content: "new", expectedRevision: revision })).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["", "old", "sha256:xyz"])("rejects invalid revision %j before transport", async (expectedRevision) => {
    const { client, fetch, invoke } = transport(runtime, source());
    await expect(client.saveWorkspaceRepositorySource(workspaceId, repositoryId, { filePath, content: "new", expectedRevision })).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["\0", "😀".repeat(524_289)])("rejects unsafe or oversized UTF-8 content before transport", async (content) => {
    const { client, fetch, invoke } = transport(runtime, source());
    await expect(client.saveWorkspaceRepositorySource(workspaceId, repositoryId, { filePath, content, expectedRevision: revision })).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid MR IID %s before transport", async (number) => {
    const { client, fetch, invoke } = transport(runtime, comparison());
    await expect(client.getWorkspaceGitlabComparison(workspaceId, repositoryId, number)).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    { schemaVersion: 2 }, { workspaceId: "other" }, { repositoryId: "other" }, { filePath: "other.ts" },
    { revision: "missing" }, { content: "\0" }, { unknown: true }, { content: "😀".repeat(524_289) },
  ])("rejects malformed or misdirected source responses", async (override) => {
    const { client } = transport(runtime, { ...source(), ...override });
    await expect(client.getWorkspaceRepositorySource(workspaceId, repositoryId, filePath)).rejects.toMatchObject({ code: "invalid_response" });
    await expect(client.saveWorkspaceRepositorySource(workspaceId, repositoryId, { filePath, content: "new", expectedRevision: revision })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each(["missingCommits", "diverged"])("keeps the published view when local comparison status is %s", async (status) => {
    const { latestWork: _latest, sinceMr: _since, ...rest } = comparison();
    const payload = { ...rest, status };
    await expect(transport(runtime, payload).client.getWorkspaceGitlabComparison(workspaceId, repositoryId, iid)).resolves.toEqual(payload);
  });

  it.each([
    { schemaVersion: 2 }, { workspaceId: "other" }, { repositoryId: "other" }, { iid: 17 },
    { status: "unknown" }, { latestWork: undefined }, { sinceMr: undefined }, { localHeadCommitOid: "main" },
    { published: { ...comparison().published, iid: 17 } },
    { latestWork: { ...diff(base), baseCommitOid: head } },
    { sinceMr: { ...diff(head), baseCommitOid: base } },
    { sinceMr: { ...diff(head), headCommitOid: head } },
    { latestWork: { ...diff(base), workspaceId: "other" } },
    { status: "diverged" }, { unknown: true },
  ])("rejects malformed or mixed comparison snapshots: %j", async (override) => {
    const { client } = transport(runtime, { ...comparison(), ...override });
    await expect(client.getWorkspaceGitlabComparison(workspaceId, repositoryId, iid)).rejects.toMatchObject({ code: "invalid_response" });
  });
});
