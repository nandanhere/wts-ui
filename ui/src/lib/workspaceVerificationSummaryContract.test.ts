import { describe, expect, it, vi } from "vitest";
import { createWorkspaceClient, type WorkspaceClientOptions } from "./wtsClient";

const workspaceId = "workspace one/+";
const result = () => ({ schemaVersion: 1, workspaceId, planRevision: 1, status: "failed", startedAtUnixMs: 100, completedAtUnixMs: 120, durationMs: 20, checks: [], warnings: [] });
const summary = () => ({ schemaVersion: 1, workspaceId, verificationPlan: { schemaVersion: 1, workspaceId, revision: 1, updatedAtUnixMs: 99, checks: [] }, verificationResult: result(), verificationHistory: [result()] });
function transport(runtime: "http" | "tauri", payload: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith("/bootstrap") ? { sessionToken: "session" } : payload)));
  const invoke = vi.fn(async () => payload);
  return { client: createWorkspaceClient({ runtime, fetch, invoke: invoke as NonNullable<WorkspaceClientOptions["invoke"]> }), fetch, invoke };
}

describe.each(["http", "tauri"] as const)("Saved verification summary through %s", runtime => {
  it("reads the saved verification contract without full evidence", async () => {
    const payload = summary();
    const { client, fetch, invoke } = transport(runtime, payload);
    await expect(client.getWorkspaceVerificationSummary!(workspaceId)).resolves.toEqual(payload);
    if (runtime === "http") {
      expect(fetch).toHaveBeenLastCalledWith(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/verification/summary`, expect.objectContaining({ headers: expect.any(Object) }));
      expect(fetch.mock.lastCall?.[1]?.method ?? "GET").toBe("GET");
    } else expect(invoke).toHaveBeenCalledExactlyOnceWith("get_workspace_verification_summary", { workspaceId });
  });
  it("returns no summary for a saved plan without setup", async () => {
    await expect(transport(runtime, null).client.getWorkspaceVerificationSummary!(workspaceId)).resolves.toBeNull();
  });
  it.each(["summary", "plan", "result", "history"])("rejects another workspace in the %s", async part => {
    const payload = summary();
    if (part === "summary") payload.workspaceId = "other";
    if (part === "plan") payload.verificationPlan.workspaceId = "other";
    if (part === "result") payload.verificationResult.workspaceId = "other";
    if (part === "history") payload.verificationHistory[0].workspaceId = "other";
    await expect(transport(runtime, payload).client.getWorkspaceVerificationSummary!(workspaceId)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it.each([
    { schemaVersion: 2 }, { verificationHistory: {} }, { verificationHistory: Array(11).fill(result()) },
    { verificationHistory: [{ ...result(), status: "running", completedAtUnixMs: null }] },
    { verificationResult: { ...result(), schemaVersion: 2 } },
  ])("rejects malformed data %j", async change => {
    await expect(transport(runtime, { ...summary(), ...change }).client.getWorkspaceVerificationSummary!(workspaceId)).rejects.toMatchObject({ code: "invalid_response" });
  });
});
