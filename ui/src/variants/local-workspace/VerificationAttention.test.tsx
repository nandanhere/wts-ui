import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fakeWorkspaceClient, workspaceEvidenceFixture } from "../../test/workspaceClientFake";
import { VerificationPanel } from "./VerificationPanel";

describe("verification attention links", () => {
  it("opens the selected historical check when the current plan has no checks", async () => {
    const evidence = workspaceEvidenceFixture();
    const failed = structuredClone(evidence.verificationResult);
    evidence.verificationPlan = { ...evidence.verificationPlan, revision: 2, checks: [] };
    evidence.verificationHistory = [failed];
    evidence.verificationResult = { ...failed, planRevision: 2, status: "notRun", startedAtUnixMs: null, checks: [] };
    const fake = fakeWorkspaceClient({ evidence });
    const runCheck = vi.fn(); fake.client.runWorkspaceVerificationCheck = runCheck;
    render(<VerificationPanel client={fake.client} workspaceId={evidence.context.workspaceId} workspaceKey="Test workspace" materialized onNotice={vi.fn()}
      revealCheck={{ requestId: "old-plan", workspaceId: evidence.context.workspaceId, checkId: failed.checks[0]!.checkId, planRevision: failed.planRevision, runStartedAt: failed.startedAtUnixMs! }} />);
    expect(await screen.findByRole("heading", { name: "No runnable checks discovered" })).toBeVisible();
    const selected = await screen.findByRole("region", { name: "Selected check result" });
    expect(within(selected).getByText("Expected one capture, received two.")).toBeVisible();
    await waitFor(() => expect(selected).toHaveFocus());
    expect(fake.runWorkspaceVerification).not.toHaveBeenCalled(); expect(runCheck).not.toHaveBeenCalled();
  });

  it("keeps the selected result visible with a recovery action when its evidence no longer exists", async () => {
    const fake = fakeWorkspaceClient({ evidence: null });
    render(<VerificationPanel client={fake.client} workspaceId="missing-workspace" workspaceKey="Test workspace" materialized onNotice={vi.fn()}
      revealCheck={{ requestId: "missing-evidence", workspaceId: "missing-workspace", checkId: "checkout-unit", planRevision: 1, runStartedAt: 1 }} />);
    expect(await screen.findByRole("heading", { name: "No evidence bundle exists yet" })).toBeVisible();
    const selected = await screen.findByRole("region", { name: "Selected check result" });
    expect(within(selected).getByText("WTS cannot find the saved evidence for this result. Select Check again to reload it.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
    expect(fake.runWorkspaceVerification).not.toHaveBeenCalled();
  });

  it("opens the exact failed run after a newer run passes without starting a check", async () => {
    const evidence = workspaceEvidenceFixture();
    const failed = structuredClone(evidence.verificationResult);
    evidence.verificationHistory = [failed];
    evidence.verificationResult = {
      ...failed, status: "passed", startedAtUnixMs: failed.startedAtUnixMs! + 10_000,
      checks: failed.checks.map(check => ({ ...check, status: "passed", detail: "The later run passed." })),
    };
    const fake = fakeWorkspaceClient({ evidence });
    const runCheck = vi.fn();
    fake.client.runWorkspaceVerificationCheck = runCheck;
    const props = { revealCheck: { requestId: "open-failed", workspaceId: evidence.context.workspaceId,
      checkId: failed.checks[0]!.checkId, planRevision: failed.planRevision, runStartedAt: failed.startedAtUnixMs! } };
    render(<VerificationPanel {...props} client={fake.client} workspaceId={evidence.context.workspaceId}
      workspaceKey="Test workspace" materialized onNotice={vi.fn()} />);
    const selected = await screen.findByRole("region", { name: "Selected check result" });
    expect(within(selected).getByText("Expected one capture, received two.")).toBeVisible();
    expect(within(selected).queryByText("The later run passed.")).not.toBeInTheDocument();
    await waitFor(() => expect(selected).toHaveFocus());
    expect(fake.runWorkspaceVerification).not.toHaveBeenCalled();
    expect(runCheck).not.toHaveBeenCalled();
  });

  it("explains when the selected run is no longer retained instead of showing another result", async () => {
    const evidence = workspaceEvidenceFixture();
    const fake = fakeWorkspaceClient({ evidence });
    const props = { revealCheck: { requestId: "old-result", workspaceId: evidence.context.workspaceId,
      checkId: "checkout-unit", planRevision: 1, runStartedAt: 1 } };
    render(<VerificationPanel {...props} client={fake.client} workspaceId={evidence.context.workspaceId}
      workspaceKey="Test workspace" materialized onNotice={vi.fn()} />);
    expect(await screen.findByText("This check result is no longer in the saved history. The current checks remain below.")).toBeVisible();
    expect(fake.runWorkspaceVerification).not.toHaveBeenCalled();
  });
});
