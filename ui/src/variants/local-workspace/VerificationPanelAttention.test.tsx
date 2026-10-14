import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceClient, WorkspaceVerificationSummary } from "../../lib/wtsClient";
import { fakeWorkspaceClient, workspaceEvidenceFixture } from "../../test/workspaceClientFake";
import { getWorkspaceAttentionStore } from "./workspaceAttention";
import { VerificationPanel } from "./VerificationPanel";

beforeEach(() => localStorage.clear());

it("updates board attention from completed check actions without another board refresh", async () => {
  const evidence = workspaceEvidenceFixture();
  evidence.verificationPlan.checks = [
    { ...evidence.verificationPlan.checks[0]!, id: "check-a", label: "Check A" },
    { ...evidence.verificationPlan.checks[0]!, id: "check-b", label: "Check B" },
  ];
  evidence.verificationResult.checks = [
    { ...evidence.verificationResult.checks[0]!, checkId: "check-a" },
    { ...evidence.verificationResult.checks[0]!, checkId: "check-b" },
  ];
  const fake = fakeWorkspaceClient({ evidence });
  let run = 0;
  const runCheck = vi.fn<NonNullable<WorkspaceClient["runWorkspaceVerificationCheck"]>>(async (_workspaceId, checkId) => ({
    ...evidence,
    verificationResult: { ...evidence.verificationResult, status: "passed", startedAtUnixMs: evidence.verificationResult.startedAtUnixMs! + 10_000 * ++run,
      checks: evidence.verificationResult.checks.map(check => ({ ...check, status: check.checkId === checkId ? "passed" : "skipped" })) },
  }));
  const summary: WorkspaceVerificationSummary = { schemaVersion: 1, workspaceId: evidence.context.workspaceId,
    verificationPlan: evidence.verificationPlan, verificationResult: evidence.verificationResult, verificationHistory: [] };
  const client: WorkspaceClient = { ...fake.client, runWorkspaceVerificationCheck: runCheck,
    listAgentConversations: vi.fn().mockResolvedValue({ schemaVersion: 1, conversations: [] }),
    getWorkspaceVerificationSummary: vi.fn().mockResolvedValue(summary),
    getGitlabMergeRequests: vi.fn().mockResolvedValue({ schemaVersion: 1, state: "fresh", detail: "Ready", fetchedAtUnixMs: Date.now(), mergeRequests: [] }),
  };
  const store = getWorkspaceAttentionStore(client);
  await store.refresh([{ workspaceId: evidence.context.workspaceId, materialized: true }]);
  expect(store.getSnapshot().items.filter(item => item.kind === "verification")).toHaveLength(2);
  render(<VerificationPanel client={client} workspaceId={evidence.context.workspaceId} workspaceKey="WTS" materialized onNotice={vi.fn()} />);
  await screen.findByRole("heading", { name: "Failed" });
  fireEvent.click(within(screen.getByText("Check B").closest("summary")!).getByRole("button", { name: "Run again" }));
  await waitFor(() => expect(store.getSnapshot().items.filter(item => item.kind === "verification")).toEqual([expect.objectContaining({ target: expect.objectContaining({ checkId: "check-a" }) })]));
  fireEvent.click(within(screen.getByText("Check A").closest("summary")!).getByRole("button", { name: "Run again" }));
  await waitFor(() => expect(store.getSnapshot().items.filter(item => item.kind === "verification")).toHaveLength(0));
  expect(store.getSnapshot().history.filter(item => item.kind === "verification")).toHaveLength(2);
  expect(client.getWorkspaceVerificationSummary).toHaveBeenCalledTimes(1);
  expect(runCheck).toHaveBeenNthCalledWith(1, evidence.context.workspaceId, "check-b");
  expect(runCheck).toHaveBeenNthCalledWith(2, evidence.context.workspaceId, "check-a");
});
