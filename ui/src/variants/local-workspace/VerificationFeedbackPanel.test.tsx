import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  fakeWorkspaceClient,
  workspaceEvidenceFixture,
} from "../../test/workspaceClientFake";
import { VerificationFeedbackPanel } from "./VerificationFeedbackPanel";

describe("VerificationFeedbackPanel", () => {
  it("anchors user context to the exact failed verification run", async () => {
    const user = userEvent.setup();
    const evidence = workspaceEvidenceFixture();
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceReviewThreads.mockResolvedValue({
      workspaceId: evidence.context.workspaceId,
      threads: [],
    });
    fake.createWorkspaceReviewThread.mockImplementation(
      async (workspaceId, target, body, author) => ({
        threadId: "1b664efa-2bea-4f3d-8ca9-4c27de62cc8f",
        workspaceId,
        target,
        anchorState: "current",
        currentVerificationCompletedAtUnixMs:
          evidence.verificationResult.completedAtUnixMs ?? undefined,
        state: "open",
        revision: 1,
        comments: [
          {
            commentId: "3c5ecaa8-ee7c-4b39-b902-49fc987d9d84",
            author: author ?? "user",
            body,
            createdAtUnixMs: 100,
          },
        ],
        createdAtUnixMs: 100,
        updatedAtUnixMs: 100,
      }),
    );

    render(
      <VerificationFeedbackPanel
        client={fake.client}
        evidence={evidence}
        onNotice={vi.fn()}
        workspaceId={evidence.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await user.click(screen.getByText("Explain failed checks"));
    await waitFor(() =>
      expect(fake.listWorkspaceReviewThreads).toHaveBeenCalledWith(
        evidence.context.workspaceId,
      ),
    );
    await user.type(
      screen.getByLabelText("Context for the agent"),
      "The local database service was not active.",
    );
    await user.click(screen.getByRole("button", { name: "Send context" }));

    expect(fake.createWorkspaceReviewThread).toHaveBeenCalledWith(
      evidence.context.workspaceId,
      {
        kind: "verificationCheck",
        planRevision: evidence.verificationResult.planRevision,
        completedAtUnixMs: evidence.verificationResult.completedAtUnixMs,
        checkId: "checkout-unit",
      },
      "The local database service was not active.",
      "user",
    );
    expect(
      await screen.findByText("The local database service was not active."),
    ).toBeVisible();
  });

  it("resolves current check feedback with its revision", async () => {
    const user = userEvent.setup();
    const evidence = workspaceEvidenceFixture();
    const thread = {
      threadId: "1b664efa-2bea-4f3d-8ca9-4c27de62cc8f",
      workspaceId: evidence.context.workspaceId,
      target: {
        kind: "verificationCheck" as const,
        planRevision: evidence.verificationResult.planRevision,
        completedAtUnixMs: evidence.verificationResult.completedAtUnixMs!,
        checkId: "checkout-unit",
      },
      anchorState: "current" as const,
      currentVerificationCompletedAtUnixMs:
        evidence.verificationResult.completedAtUnixMs!,
      state: "open" as const,
      revision: 3,
      comments: [
        {
          commentId: "3c5ecaa8-ee7c-4b39-b902-49fc987d9d84",
          author: "user" as const,
          body: "The failure is expected on this laptop.",
          createdAtUnixMs: 100,
        },
      ],
      createdAtUnixMs: 100,
      updatedAtUnixMs: 100,
    };
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceReviewThreads.mockResolvedValue({
      workspaceId: evidence.context.workspaceId,
      threads: [thread],
    });
    fake.resolveWorkspaceReviewThread.mockResolvedValue({
      ...thread,
      state: "resolved",
      revision: 4,
      resolvedAtUnixMs: 120,
    });

    render(
      <VerificationFeedbackPanel
        client={fake.client}
        evidence={evidence}
        onNotice={vi.fn()}
        workspaceId={evidence.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await user.click(screen.getByText("Explain failed checks"));
    const feedback = await screen.findByLabelText("Check feedback");
    await user.click(within(feedback).getByRole("button", { name: "Resolve" }));

    expect(fake.resolveWorkspaceReviewThread).toHaveBeenCalledWith(
      evidence.context.workspaceId,
      thread.threadId,
      3,
    );
    expect(await within(feedback).findByText("Resolved")).toBeVisible();
  });
});
