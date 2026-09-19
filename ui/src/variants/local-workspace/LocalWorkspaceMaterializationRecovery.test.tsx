import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { WorkspaceClientError, type WorkspacePreflight } from "../../lib/wtsClient";
import { fakeWorkspaceClient, repositoryCatalogFixture, workspaceFixture, workspaceListFixture } from "../../test/workspaceClientFake";
import { LocalWorkspace } from "./LocalWorkspace";
import { assistantMaterialization } from "./localWorkspaceTestHelpers";

describe("Workspace setup failure recovery", () => {
  for (const automatic of [false, true]) {
    it.each([true, false])(`${automatic ? "automatic MR" : "manual"} creation requires a new review after cleanup complete=%s`, async cleanupComplete => {
      const user = userEvent.setup();
      const catalog = repositoryCatalogFixture();
      const repository = catalog.repositories[0]!;
      const workspace = workspaceFixture({
        ...(automatic ? { intent: { type: "repositorySet" as const, label: "Review acme/checkout-api !17" }, title: "Review acme/checkout-api !17" } : {}),
        repositories: [{ requestId: repository.id, repositoryId: repository.id, label: repository.label, baseRef: "feat/review-checkout", worktreeLeaf: "checkout-api" }],
      });
      const materialization = assistantMaterialization(workspace);
      const preflight: WorkspacePreflight = { workspaceId: workspace.workspaceId, workspaceDisplayPath: workspace.workspaceDisplayPath, codeWorkspaceDisplayPath: materialization.codeWorkspaceDisplayPath, branchName: materialization.branchName, ready: true, effectDigest: "sha256:first-review", repositories: [{ repositoryId: repository.id, label: repository.label, sourceDisplayPath: "/repos/checkout-api", requestedBaseRef: "feat/review-checkout", resolvedBaseRef: "refs/heads/feat/review-checkout", baseCommitOid: materialization.worktrees[0]!.baseCommitOid, targetDisplayPath: materialization.worktrees[0]!.targetDisplayPath }], blockers: [], warnings: [], graph: materialization.graph };
      const fake = fakeWorkspaceClient({
        list: workspaceListFixture(automatic ? [] : [workspace]), repositories: catalog,
        create: { workspace, replayed: false }, preflight, materialize: { replayed: false, materialization },
        ...(automatic ? { gitlabReviewInbox: { schemaVersion: 1 as const, state: "fresh" as const, reviews: [{ id: "1017", repositoryId: repository.id, repository: "acme/checkout-api", number: 17, title: "Review checkout delivery", authorLogin: "bob", sourceBranch: "feat/review-checkout", targetBranch: "main", updatedAt: "2026-08-17T09:00:00Z", draft: false, reviewState: "requested" as const, status: "open" as const }], fetchedAtUnixMs: 1, detail: "Review request available." } } : {}),
        removalPreflight: { workspaceId: workspace.workspaceId, workspaceDisplayPath: workspace.workspaceDisplayPath, kind: "savedPlan", ready: false, effectDigest: "sha256:removal", worktrees: [], generatedPaths: [], protectedPaths: [], retainedBranches: [], warnings: [], blockers: [{ code: "unexpectedPath", message: "A preserved path needs inspection.", displayPath: workspace.workspaceDisplayPath }] },
      });
      fake.prepareGitlabReviewRepository.mockResolvedValue({ repository, repositoryRootDisplayPath: catalog.repositoryRootDisplayPath, reusedExisting: true });
      fake.materializeWorkspace.mockRejectedValueOnce(new WorkspaceClientError("Generated workspace files could not be written.", { code: cleanupComplete ? "generated_workspace_failed" : "generated_workspace_cleanup_incomplete", retryable: cleanupComplete }));
      fake.preflightWorkspace.mockResolvedValueOnce(preflight).mockResolvedValue({ ...preflight, effectDigest: "sha256:fresh-review" });
      render(<LocalWorkspace client={fake.client} />);
      if (automatic) {
        await user.click(await screen.findByRole("button", { name: "Start review" }));
      } else {
        await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
        await user.click(await screen.findByRole("button", { name: "Review setup" }));
        await user.click(within(document.querySelector('[data-ui="workspace-overview.setup"]') as HTMLElement).getByRole("button", { name: "Create workspace" }));
      }
      await waitFor(() => expect(fake.materializeWorkspace).toHaveBeenCalledTimes(1));
      const setup = document.querySelector('[data-ui="workspace-overview.setup"]') as HTMLElement;
      await within(setup).findByText("Generated workspace files could not be written.");
      expect(within(setup).queryByRole("button", { name: "Create workspace" })).not.toBeInTheDocument();
      expect(within(setup).queryByText(/Nothing has changed yet/)).not.toBeInTheDocument();
      expect(within(setup).getByRole("button", { name: "Review setup" })).toBeEnabled();
      if (!cleanupComplete) {
        expect(within(setup).getByText(/Inspect the preserved files/)).toBeVisible();
        await user.click(within(setup).getByRole("button", { name: "Review remaining files" }));
        const removal = await screen.findByRole("dialog", { name: /Remove.*plan/ });
        expect(within(removal).getByText("A preserved path needs inspection.")).toBeVisible();
        expect(within(removal).getByRole("button", { name: "Copy workspace path" })).toBeEnabled();
        expect(fake.preflightWorkspaceRemoval).toHaveBeenCalledWith(workspace.workspaceId);
        expect(fake.removeWorkspace).not.toHaveBeenCalled();
        await user.click(within(removal).getByRole("button", { name: "Close removal dialog" }));
      } else {
        expect(within(setup).queryByRole("button", { name: "Review remaining files" })).not.toBeInTheDocument();
      }
      await user.click(within(setup).getByRole("button", { name: "Review setup" }));
      await waitFor(() => expect(fake.preflightWorkspace).toHaveBeenCalledTimes(2));
      expect(fake.materializeWorkspace).toHaveBeenCalledTimes(1);
      await user.click(await within(setup).findByRole("button", { name: "Create workspace" }));
      await waitFor(() => expect(fake.materializeWorkspace).toHaveBeenCalledTimes(2));
      expect(fake.materializeWorkspace).toHaveBeenLastCalledWith(workspace.workspaceId, "sha256:fresh-review", expect.any(String));
      expect(fake.launchAgentSession).not.toHaveBeenCalled();
    });
  }
  it.each([false, true])("routes only workspace-scoped target conflicts to file recovery (repository=%s)", async repositoryScoped => {
    const user = userEvent.setup();
    const workspace = workspaceFixture();
    const path = `${workspace.workspaceDisplayPath}/WTS.md`;
    const message = `WTS cannot create its files at \`${path}\`. Preserve the existing contents and move this path outside the workspace. Select Check again.`;
    const preflight: WorkspacePreflight = { workspaceId: workspace.workspaceId, workspaceDisplayPath: workspace.workspaceDisplayPath, codeWorkspaceDisplayPath: `${workspace.workspaceDisplayPath}/wts.code-workspace`, branchName: "wts/setup", ready: false, effectDigest: "sha256:blocked", repositories: [], blockers: [{ code: "targetConflict", message, ...(repositoryScoped ? { repositoryId: "repo_checkout", repositoryLabel: "checkout-api" } : {}) }], warnings: [], graph: { status: "notStarted", detail: "Not started." } };
    const fake = fakeWorkspaceClient({ list: workspaceListFixture([workspace]), preflight,
      removalPreflight: { workspaceId: workspace.workspaceId, workspaceDisplayPath: workspace.workspaceDisplayPath, kind: "savedPlan", ready: false, effectDigest: "sha256:removal", worktrees: [], generatedPaths: [], protectedPaths: [], retainedBranches: [], warnings: [], blockers: [{ code: "unexpectedPath", message: "A preserved path needs inspection.", displayPath: path }] },
    });
    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
    await user.click(await screen.findByRole("button", { name: "Review setup" }));
    const setup = document.querySelector('[data-ui="workspace-overview.setup"]') as HTMLElement;
    await within(setup).findByText(message);
    if (repositoryScoped) {
      expect(within(setup).queryByRole("button", { name: "Review remaining files" })).not.toBeInTheDocument();
      expect(within(setup).queryByRole("button", { name: "Copy setup path" })).not.toBeInTheDocument();
    } else {
      await user.click(within(setup).getByRole("button", { name: "Copy setup path" }));
      expect(await navigator.clipboard.readText()).toBe(workspace.workspaceDisplayPath);
      await user.click(within(setup).getByRole("button", { name: "Review remaining files" }));
      const removal = await screen.findByRole("dialog", { name: /Remove.*plan/ });
      expect(within(removal).getAllByText(path).length).toBeGreaterThan(0);
      expect(fake.preflightWorkspaceRemoval).toHaveBeenCalledExactlyOnceWith(workspace.workspaceId);
    }
    expect(fake.materializeWorkspace).not.toHaveBeenCalled();
    expect(fake.removeWorkspace).not.toHaveBeenCalled();
  });

});


describe("Reviewed setup cleanup", () => {
  const digest = `sha256:${"b".repeat(64)}`;
  function fixture(blockers: string[] = []) {
    const workspace = workspaceFixture();
    const materialization = assistantMaterialization(workspace);
    const path = `${workspace.workspaceDisplayPath}/WTS.md`;
    const preflight: WorkspacePreflight = {
      workspaceId: workspace.workspaceId, workspaceDisplayPath: workspace.workspaceDisplayPath,
      codeWorkspaceDisplayPath: materialization.codeWorkspaceDisplayPath, branchName: materialization.branchName,
      ready: false, effectDigest: `sha256:${"a".repeat(64)}`, repositories: [], blockers: [], warnings: [], graph: materialization.graph,
      setupRecovery: { effectDigest: digest, ready: blockers.length === 0, paths: [path], blockers },
    };
    const fresh = { ...preflight, ready: true, effectDigest: `sha256:${"c".repeat(64)}`, setupRecovery: undefined };
    const fake = fakeWorkspaceClient({ list: workspaceListFixture([workspace]), preflight, materialize: { replayed: false, materialization } });
    return { workspace, path, preflight, fresh, fake };
  }
  async function openSetup(user: ReturnType<typeof userEvent.setup>, client: ReturnType<typeof fakeWorkspaceClient>["client"]) {
    render(<LocalWorkspace client={client} />);
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
    await user.click(await screen.findByRole("button", { name: "Review setup" }));
    const setup = within(document.querySelector('[data-ui="workspace-overview.setup"]') as HTMLElement);
    await setup.findByRole("button", { name: "Clean setup files" });
    return setup;
  }
  it("keeps cleanup before a large path list and reveals exact paths on request", async () => {
    const user = userEvent.setup();
    const { fake, preflight } = fixture();
    const paths = Array.from({ length: 24 }, (_, index) => `${preflight.workspaceDisplayPath}/.wts/setup-${index}.md`);
    preflight.setupRecovery!.paths = paths;
    const setup = await openSetup(user, fake.client);
    const clean = setup.getByRole("button", { name: "Clean setup files" });
    const disclosure = setup.getByText("Review 24 setup paths");
    expect(setup.getByText(paths[23]!)).not.toBeVisible();
    expect(clean.compareDocumentPosition(disclosure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(disclosure);
    expect(setup.getByText(paths[23]!)).toBeVisible();
    await user.click(setup.getByRole("button", { name: `Copy path ${paths[23]}` }));
    expect(await navigator.clipboard.readText()).toBe(paths[23]);
    expect(fake.recoverWorkspaceSetup).not.toHaveBeenCalled();
  });
  it("cleans only after an explicit review and requires Create on the fresh review", async () => {
    const user = userEvent.setup();
    const { workspace, path, fresh, fake } = fixture();
    let finish!: (value: WorkspacePreflight) => void;
    fake.recoverWorkspaceSetup.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const setup = await openSetup(user, fake.client);
    await user.click(setup.getByText("Review 1 setup path"));
    expect(setup.getByText(path)).toBeVisible();
    expect(setup.getByText(/WTS keeps your saved plan/)).toBeVisible();
    expect(fake.recoverWorkspaceSetup).not.toHaveBeenCalled();
    expect(setup.queryByRole("button", { name: "Create workspace" })).not.toBeInTheDocument();
    await user.dblClick(setup.getByRole("button", { name: "Clean setup files" }));
    expect(fake.recoverWorkspaceSetup).toHaveBeenCalledExactlyOnceWith(workspace.workspaceId, digest);
    expect(setup.getByRole("button", { name: "Check again" })).toBeDisabled();
    await act(async () => finish(fresh));
    expect(fake.materializeWorkspace).not.toHaveBeenCalled();
    await user.click(await setup.findByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(fake.materializeWorkspace).toHaveBeenCalledExactlyOnceWith(workspace.workspaceId, fresh.effectDigest, expect.any(String)));
    expect(fake.removeWorkspace).not.toHaveBeenCalled();
    expect(fake.createWorkspace).not.toHaveBeenCalled();
  });
  it("keeps blocked paths visible and provides exact path copy without cleanup", async () => {
    const user = userEvent.setup();
    const blocker = "A changed file remains. Inspect the preserved files before you check setup again.";
    const { path, fake } = fixture([blocker]);
    const setup = await openSetup(user, fake.client);
    expect(setup.getByRole("button", { name: "Clean setup files" })).toBeDisabled();
    expect(setup.getByText(blocker)).toBeVisible();
    await user.click(setup.getByText("Review 1 setup path"));
    await user.click(setup.getByRole("button", { name: `Copy path ${path}` }));
    expect(await navigator.clipboard.readText()).toBe(path);
    await user.click(setup.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(fake.preflightWorkspace).toHaveBeenCalledTimes(2));
    expect(fake.recoverWorkspaceSetup).not.toHaveBeenCalled();
    expect(fake.removeWorkspace).not.toHaveBeenCalled();
    expect(fake.materializeWorkspace).not.toHaveBeenCalled();
  });
  it("requires a fresh review after an uncertain cleanup response", async () => {
    const user = userEvent.setup();
    const { fake, preflight } = fixture();
    fake.recoverWorkspaceSetup.mockRejectedValue(new WorkspaceClientError("The cleanup response was lost.", { code: "transport_error", retryable: true }));
    const setup = await openSetup(user, fake.client);
    await user.click(setup.getByRole("button", { name: "Clean setup files" }));
    await setup.findByText(/The cleanup response was lost/);
    expect(setup.queryByRole("button", { name: "Clean setup files" })).not.toBeInTheDocument();
    expect(setup.queryByRole("button", { name: "Create workspace" })).not.toBeInTheDocument();
    expect(setup.getByText(/Review setup again before/)).toBeVisible();
    expect(screen.getByRole("heading", { name: /Checkout retries create duplicate captures/ })).toBeVisible();
    const freshDigest = `sha256:${"d".repeat(64)}`;
    fake.preflightWorkspace.mockResolvedValue({ ...preflight, setupRecovery: { ...preflight.setupRecovery!, effectDigest: freshDigest } });
    await user.click(setup.getByRole("button", { name: "Review setup" }));
    await setup.findByRole("button", { name: "Clean setup files" });
    expect(fake.recoverWorkspaceSetup).toHaveBeenCalledTimes(1);
    await user.click(setup.getByRole("button", { name: "Clean setup files" }));
    await waitFor(() => expect(fake.recoverWorkspaceSetup).toHaveBeenLastCalledWith(preflight.workspaceId, freshDigest));
    expect(fake.materializeWorkspace).not.toHaveBeenCalled();
    expect(fake.removeWorkspace).not.toHaveBeenCalled();
  });
});
