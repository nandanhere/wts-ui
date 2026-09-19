import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceClient, type WorkspaceClientOptions } from "./wtsClient";

const workspaceId = "workspace one/+";
const digest = `sha256:${"a".repeat(64)}`;
const recovery = () => ({ effectDigest: digest, ready: true, paths: ["/tmp/workspace/WTS.md"], blockers: [] as string[] });
const preflight = () => ({ workspaceId, workspaceDisplayPath: "/tmp/workspace", codeWorkspaceDisplayPath: "/tmp/workspace/wts.code-workspace", branchName: "wts/setup", ready: false, effectDigest: digest, repositories: [], blockers: [], warnings: [], graph: { status: "notStarted", detail: "Not started." }, setupRecovery: recovery() });
function transport(runtime: "http" | "tauri", payload: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith("/bootstrap") ? { sessionToken: "session" } : payload)));
  const invoke = vi.fn(async () => payload);
  return { client: createWorkspaceClient({ runtime, fetch, invoke: invoke as NonNullable<WorkspaceClientOptions["invoke"]> }), fetch, invoke };
}
afterEach(() => Reflect.deleteProperty(window, "__WTS_NATIVE_PREVIEW__"));

describe.each(["http", "tauri"] as const)("Setup recovery through %s", runtime => {
  it("retains the exact recovery review in preflight", async () => {
    const payload = preflight();
    await expect(transport(runtime, payload).client.preflightWorkspace(workspaceId)).resolves.toEqual(payload);
  });
  it("sends the exact reviewed digest and returns a fresh setup review", async () => {
    const payload = { ...preflight(), ready: true, setupRecovery: undefined };
    const { client, fetch, invoke } = transport(runtime, payload);
    await expect(client.recoverWorkspaceSetup(workspaceId, digest)).resolves.toMatchObject({ workspaceId, ready: true });
    if (runtime === "http") {
      expect(fetch).toHaveBeenLastCalledWith(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/setup-recovery`, expect.objectContaining({ method: "POST", body: JSON.stringify({ effectDigest: digest }) }));
    } else expect(invoke).toHaveBeenCalledExactlyOnceWith("recover_workspace_setup", { workspaceId, effectDigest: digest });
  });
  it("rejects a fresh review for another workspace", async () => {
    await expect(transport(runtime, { ...preflight(), workspaceId: "another" }).client.recoverWorkspaceSetup(workspaceId, digest)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it.each(["", "sha256:bad", `sha256:${"A".repeat(64)}`])("rejects an invalid request digest %s before transport", async value => {
    const { client, fetch, invoke } = transport(runtime, preflight());
    await expect(client.recoverWorkspaceSetup(workspaceId, value)).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });
  it.each([
    { effectDigest: "bad" }, { ready: "yes" }, { paths: [3] }, { paths: ["x".repeat(4097)] },
    { paths: Array(1025).fill("path") }, { blockers: ["x".repeat(4097)], ready: false },
    { blockers: Array(1025).fill("blocked"), ready: false }, { blockers: ["A changed file remains."] },
    { ready: false }, { paths: ["bad\u0000path"] },
  ])("rejects malformed recovery data %j", async change => {
    const payload = preflight(); Object.assign(payload.setupRecovery, change);
    await expect(transport(runtime, payload).client.preflightWorkspace(workspaceId)).rejects.toMatchObject({ code: "invalid_response" });
  });
});

it("never sends setup cleanup to the native preview", async () => {
  Object.defineProperty(window, "__WTS_NATIVE_PREVIEW__", { configurable: true, value: { schemaVersion: 1, allowedCommands: ["preflight_workspace"] } });
  const { client, invoke } = transport("tauri", preflight());
  await expect(client.recoverWorkspaceSetup(workspaceId, digest)).rejects.toMatchObject({ code: "preview_read_only", retryable: false });
  expect(invoke).not.toHaveBeenCalled();
});
