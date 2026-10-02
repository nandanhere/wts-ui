import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import type { WorkspaceAgentEvidence, WorkspaceEvidence, WorkspaceMaterialization } from "../../lib/wtsClient";
import { workspaceEvidenceFixture, workspaceFixture } from "../../test/workspaceClientFake";

export async function selectWorkspaceView(
  user: ReturnType<typeof userEvent.setup>,
  name: "Plans & Kanban" | "Changes" | "Verification",
) {
  const label =
    name === "Plans & Kanban"
      ? "Plans"
      : name === "Verification"
        ? "Verify"
        : name;
  await user.click(screen.getByRole("tab", { name: label }));
}

export async function selectWorkspaceAction(
  user: ReturnType<typeof userEvent.setup>,
  name: "Open workspace" | "Open with…",
) {
  await user.click(
    await screen.findByRole("button", { name: "Workspace actions" }),
  );
  await user.click(screen.getByRole("menuitem", { name }));
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function assistantMaterialization(
  workspace: ReturnType<typeof workspaceFixture>,
  graphStatus: WorkspaceMaterialization["graph"]["status"] = "ready",
): WorkspaceMaterialization {
  const repository = workspace.repositories[0]!;
  return {
    schemaVersion: 1,
    workspaceId: workspace.workspaceId,
    workspaceRecordVersion: workspace.recordVersion,
    effectDigest: `sha256:${workspace.workspaceId}`,
    workspaceDisplayPath: workspace.workspaceDisplayPath,
    codeWorkspaceDisplayPath: `${workspace.workspaceDisplayPath}/wts.code-workspace`,
    branchName: `wts/${workspace.workspaceId}`,
    worktrees: [
      {
        repositoryId: repository.repositoryId ?? repository.requestId,
        label: repository.label,
        targetDisplayPath: `${workspace.workspaceDisplayPath}/${repository.worktreeLeaf}`,
        branchName: `wts/${workspace.workspaceId}`,
        baseCommitOid: "0123456789abcdef0123456789abcdef01234567",
      },
    ],
    graph: {
      status: graphStatus,
      detail:
        graphStatus === "ready"
          ? "Workspace graph is ready."
          : "Workspace graph has not been built.",
    },
  };
}

export function assistantEvidence(
  workspace: ReturnType<typeof workspaceFixture>,
  agentRuns: WorkspaceAgentEvidence[],
): WorkspaceEvidence {
  const evidence = workspaceEvidenceFixture();
  return {
    ...evidence,
    context: {
      ...evidence.context,
      workspaceId: workspace.workspaceId,
      title: workspace.title,
      workspaceDisplayPath: workspace.workspaceDisplayPath,
      codeWorkspaceDisplayPath: `${workspace.workspaceDisplayPath}/wts.code-workspace`,
      evidenceDisplayPath: `${workspace.workspaceDisplayPath}/.wts`,
    },
    graphManifest: {
      ...evidence.graphManifest,
      workspaceId: workspace.workspaceId,
      graphDisplayPath: `${workspace.workspaceDisplayPath}/graphify-out/graph.json`,
    },
    verificationPlan: {
      ...evidence.verificationPlan,
      workspaceId: workspace.workspaceId,
    },
    verificationResult: {
      ...evidence.verificationResult,
      workspaceId: workspace.workspaceId,
    },
    agentRuns,
  };
}

export async function reachJiraManifest(
  user: ReturnType<typeof userEvent.setup>,
  issueKey: string,
  repositories: string,
) {
  await user.click(
    screen.getAllByRole("button", { name: /New workspace/i })[0]!,
  );
  const dialog = screen.getByRole("dialog", { name: "New workspace" });

  await user.type(
    within(dialog).getByRole("textbox", {
      name: /Jira issue key or URL/i,
    }),
    issueKey,
  );
  await user.type(
    within(dialog).getByRole("textbox", {
      name: "Repositories for this plan",
    }),
    repositories,
  );
  await user.click(
    within(dialog).getByRole("button", {
      name: /Review repositories/i,
    }),
  );
  await user.click(
    within(dialog).getByRole("button", { name: /Analyze services/i }),
  );
  await waitFor(() => {
    expect(
      within(dialog).queryByRole("button", { name: /Review plan/i }) ??
        within(dialog).queryByRole("button", {
          name: "Continue without services",
        }),
    ).not.toBeNull();
  });
  const continueWithoutServices = within(dialog).queryByRole("button", {
    name: "Continue without services",
  });
  await user.click(
    continueWithoutServices ??
      within(dialog).getByRole("button", { name: /Review plan/i }),
  );

  return dialog;
}
