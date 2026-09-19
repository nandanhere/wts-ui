import { describe, expect, it, vi } from "vitest";
import { createWorkspaceClient, type WorkspaceClientOptions } from "./wtsClient";
import { agentTurnChangesFixture, TURN_CONVERSATION_ID as conversationId, TURN_REQUEST_ID as turnRequestId } from "../test/agentTurnChangesFixture";

const receipt = agentTurnChangesFixture();
export const mutationId = "99999999-9999-4999-8999-999999999999";
export const checksFixture = () => ({ schemaVersion: 1, conversationId, requestId: turnRequestId, sessionId: receipt.sessionId, workspaceId: receipt.workspaceId, repositoryId: receipt.repositoryId, afterCheckpointId: receipt.after!.checkpointId, state: "ready", detail: "WTS can run the saved checks.", checks: [{ checkId: "unit", label: "Unit tests", kind: "unit", planRevision: 1 }], runs: [] as unknown[] });
export const restoreFixture = () => ({ schemaVersion: 1, conversationId, requestId: turnRequestId, sessionId: receipt.sessionId, workspaceId: receipt.workspaceId, repositoryId: receipt.repositoryId, afterCheckpointId: receipt.after!.checkpointId, state: "ready", effectDigest: `sha256:${"e".repeat(64)}`, files: [{ filePath: "src/title.ts", action: "restore" }], blockers: [], detail: "WTS can restore the listed files." });
const run = { runId: mutationId, checkId: "unit", status: "passed", startedAtUnixMs: 1, completedAtUnixMs: 2, durationMs: 1, exitCode: 0, output: "Tests passed.", outputTruncated: false, detail: "The check passed." };
const runRequest = { requestId: mutationId, checkId: "unit", expectedAfterCheckpointId: receipt.after!.checkpointId, expectedPlanRevision: 1 };
function transport(runtime: "http" | "tauri", result: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith("/bootstrap") ? { sessionToken: "test-session" } : result), { status: 200, headers: { "Content-Type": "application/json" } }));
  const invoke = vi.fn(async () => result);
  return { fetch, invoke, client: createWorkspaceClient({ runtime, fetch, invoke: invoke as NonNullable<WorkspaceClientOptions["invoke"]> }) };
}
describe.each(["http", "tauri"] as const)("task checks and restore over %s", runtime => {
  it("reads checks for the exact turn without running a command", async () => {
    const result = checksFixture(); const { client, fetch, invoke } = transport(runtime, result);
    await expect(client.getAgentTurnChecks!(conversationId, turnRequestId)).resolves.toEqual(result);
    if (runtime === "http") expect(fetch.mock.calls[1]).toEqual([`/api/v1/agent-conversations/${conversationId}/messages/${turnRequestId}/checks`, expect.objectContaining({ headers: expect.objectContaining({ "X-WTS-Session": "test-session" }) })]);
    else expect(invoke).toHaveBeenCalledExactlyOnceWith("get_agent_turn_checks", { conversationId, requestId: turnRequestId });
  });
  it("sends the exact approved check and binds its acknowledgement", async () => {
    const result = { ...checksFixture(), runs: [run] }; const { client, fetch, invoke } = transport(runtime, result);
    await expect(client.runAgentTurnCheck!(conversationId, turnRequestId, runRequest)).resolves.toEqual(result);
    if (runtime === "http") expect(fetch.mock.calls[1]).toEqual([`/api/v1/agent-conversations/${conversationId}/messages/${turnRequestId}/checks`, expect.objectContaining({ method: "POST", body: JSON.stringify(runRequest) })]);
    else expect(invoke).toHaveBeenCalledExactlyOnceWith("run_agent_turn_check", { conversationId, turnRequestId, request: runRequest });
  });
  it("reads exact restore effects before any mutation", async () => {
    const result = restoreFixture(); const { client, fetch, invoke } = transport(runtime, result);
    await expect(client.preflightAgentTurnRestore!(conversationId, turnRequestId)).resolves.toEqual(result);
    if (runtime === "http") expect(fetch.mock.calls[1][0]).toBe(`/api/v1/agent-conversations/${conversationId}/messages/${turnRequestId}/restore-preflight`);
    else expect(invoke).toHaveBeenCalledExactlyOnceWith("preflight_agent_turn_restore", { conversationId, requestId: turnRequestId });
  });
  it("sends only the exact restore effect digest and mutation identity", async () => {
    const preflight = restoreFixture(); const request = { requestId: mutationId, effectDigest: preflight.effectDigest };
    const result = { schemaVersion: 1, conversationId, requestId: turnRequestId, restoreRequestId: mutationId, state: "restored", restoredAtUnixMs: 3, files: preflight.files, blockers: [], detail: "WTS restored the listed files." };
    const { client, fetch, invoke } = transport(runtime, result);
    await expect(client.restoreAgentTurn!(conversationId, turnRequestId, request)).resolves.toEqual(result);
    if (runtime === "http") expect(fetch.mock.calls[1]).toEqual([`/api/v1/agent-conversations/${conversationId}/messages/${turnRequestId}/restore`, expect.objectContaining({ method: "POST", body: JSON.stringify(request) })]);
    else expect(invoke).toHaveBeenCalledExactlyOnceWith("restore_agent_turn", { conversationId, turnRequestId, request });
  });
  it.each([
    ["identity", { conversationId: turnRequestId }], ["session", { sessionId: "session" }],
    ["checkpoint", { afterCheckpointId: undefined }], ["state", { state: "passed" }],
    ["detail bytes", { detail: "😀".repeat(513) }], ["checks bound", { checks: Array.from({ length: 65 }, (_, i) => ({ checkId: `${i}`, label: "Check", kind: "unit", planRevision: 1 })) }],
    ["check name", { checks: [{ checkId: "run;rm", label: "Check", kind: "unit", planRevision: 1 }] }],
    ["label bytes", { checks: [{ checkId: "unit", label: "😀".repeat(129), kind: "unit", planRevision: 1 }] }],
    ["check kind", { checks: [{ checkId: "unit", label: "Check", kind: "shell", planRevision: 1 }] }],
    ["revision", { checks: [{ checkId: "unit", label: "Check", kind: "unit", planRevision: 0 }] }],
    ["duplicate checks", { checks: [checksFixture().checks[0], checksFixture().checks[0]] }],
    ["runs bound", { runs: Array.from({ length: 65 }, () => run) }],
    ["duplicate runs", { runs: [run, run] }],
    ["run status", { runs: [{ ...run, status: "success" }] }],
    ["run ID", { runs: [{ ...run, runId: "run" }] }],
    ["output bytes", { runs: [{ ...run, output: "😀".repeat(16385) }] }],
    ["output NUL", { runs: [{ ...run, output: "x\0y" }] }],
    ["output flag", { runs: [{ ...run, outputTruncated: 1 }] }],
    ["exit code", { runs: [{ ...run, exitCode: 1.2 }] }],
    ["duration", { runs: [{ ...run, durationMs: -1 }] }],
  ])("rejects malformed check %s", async (_name, change) => {
    await expect(transport(runtime, { ...checksFixture(), ...(change as object) }).client.getAgentTurnChecks!(conversationId, turnRequestId)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it.each([
    ["missing run", []], ["another run", [{ ...run, runId: conversationId }]], ["another check", [{ ...run, checkId: "lint" }]],
  ])("rejects an unconfirmed check mutation: %s", async (_name, runs) => {
    await expect(transport(runtime, { ...checksFixture(), runs }).client.runAgentTurnCheck!(conversationId, turnRequestId, runRequest)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it.each([
    { requestId: "invalid" }, { checkId: "unit;exit" }, { expectedAfterCheckpointId: "head" }, { expectedPlanRevision: 0 }, { command: "not allowed" },
  ])("rejects malformed check requests before transport %j", async change => {
    const { client, fetch, invoke } = transport(runtime, checksFixture());
    await expect(client.runAgentTurnCheck!(conversationId, turnRequestId, { ...runRequest, ...change })).rejects.toBeDefined(); expect(fetch).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });
  it.each([
    ["identity", { requestId: conversationId }], ["state", { state: "safe" }], ["digest", { effectDigest: "e".repeat(64) }],
    ["ready checkpoint", { afterCheckpointId: undefined }], ["resume ID", { resumeRequestId: "bad" }], ["ready blockers", { blockers: [{ code: "changed", detail: "Changed" }] }],
    ["path bytes", { files: [{ filePath: "😀".repeat(1025), action: "restore" }] }],
    ["duplicate files", { files: [restoreFixture().files[0], restoreFixture().files[0]] }],
    ["effect action", { files: [{ filePath: "x", action: "overwrite" }] }],
    ["file bound", { files: Array.from({ length: 2049 }, (_, i) => ({ filePath: `${i}`, action: "restore" })) }],
    ["blocker bound", { state: "blocked", blockers: Array.from({ length: 2049 }, () => ({ code: "changed", detail: "Changed" })) }],
    ["blocker detail", { state: "blocked", blockers: [{ code: "changed", detail: "😀".repeat(513) }] }],
  ])("rejects malformed restore %s", async (_name, change) => {
    await expect(transport(runtime, { ...restoreFixture(), ...(change as object) }).client.preflightAgentTurnRestore!(conversationId, turnRequestId)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("rejects another restore acknowledgement and invalid requests before dispatch", async () => {
    const request = { requestId: mutationId, effectDigest: restoreFixture().effectDigest };
    await expect(transport(runtime, { schemaVersion: 1, conversationId, requestId: turnRequestId, restoreRequestId: conversationId, state: "restored", files: [], blockers: [], detail: "Done" }).client.restoreAgentTurn!(conversationId, turnRequestId, request)).rejects.toMatchObject({ code: "invalid_response" });
    for (const change of [{ effectDigest: "bad" }, { requestId: "bad" }, { force: true }]) {
      const { client, fetch, invoke } = transport(runtime, {});
      await expect(client.restoreAgentTurn!(conversationId, turnRequestId, { ...request, ...change })).rejects.toBeDefined(); expect(fetch).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
    }
  });
  it("accepts exact UTF-8 limits and preserves failed output", async () => {
    const result = { ...checksFixture(), detail: "😀".repeat(512), checks: [{ ...checksFixture().checks[0], label: "😀".repeat(128) }], runs: [{ ...run, status: "failed", output: "😀".repeat(16384) }] };
    await expect(transport(runtime, result).client.getAgentTurnChecks!(conversationId, turnRequestId)).resolves.toEqual(result);
  });

});
