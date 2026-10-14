import { describe, expect, it, vi } from "vitest";
import { createWorkspaceClient, type WorkspaceClientOptions } from "./wtsClient";

const workspaceId = "workspace one/+";
const preflight = () => ({
  workspaceId, kind: "materializedWorkspace", workspaceDisplayPath: "/tmp/review workspace", ready: false,
  effectDigest: `sha256:${"a".repeat(64)}`, worktrees: [], generatedPaths: [], protectedPaths: [], retainedBranches: ["main"], warnings: [],
  blockers: [{ code: "workspaceDrift", message: "The branch changed.", repositoryLabel: "api", displayPath: "/tmp/review workspace/api", expected: "main", observed: "feature", recoverySteps: ["Register the Git changes.", "Check again before removal."] }],
});
function transport(runtime: "http" | "tauri", payload: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => new Response(JSON.stringify(String(url).endsWith("/bootstrap") ? { sessionToken: "session" } : payload), { status: 200 }));
  const invoke = vi.fn(async () => payload);
  return { client: createWorkspaceClient({ runtime, fetch, invoke: invoke as NonNullable<WorkspaceClientOptions["invoke"]> }), fetch, invoke };
}

describe.each(["http", "tauri"] as const)("Removal recovery through %s", (runtime) => {
  it("retains an active operation blocker from the host", async () => {
    const payload = preflight();
    payload.blockers[0]!.code = "activeOperation";
    await expect(transport(runtime, payload).client.preflightWorkspaceRemoval(workspaceId)).resolves.toEqual(payload);
  });

  it("retains the exact blocker path, facts, and recovery steps from the service", async () => {
    const { client, fetch, invoke } = transport(runtime, preflight());
    await expect(client.preflightWorkspaceRemoval(workspaceId)).resolves.toEqual(preflight());
    if (runtime === "http") expect(fetch).toHaveBeenLastCalledWith(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/removal-preflight`, expect.anything());
    else expect(invoke).toHaveBeenCalledWith("preflight_workspace_removal", { workspaceId });
  });

  it.each(["displayPath", "expected", "observed", "recoverySteps"])("rejects malformed %s recovery data", async (field) => {
    const payload = preflight();
    Object.assign(payload.blockers[0]!, { [field]: field === "recoverySteps" ? [17] : { value: "path" } });
    await expect(transport(runtime, payload).client.preflightWorkspaceRemoval(workspaceId)).rejects.toMatchObject({ code: "invalid_response" });
  });
});
