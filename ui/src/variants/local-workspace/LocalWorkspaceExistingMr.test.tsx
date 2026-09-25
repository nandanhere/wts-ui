import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AgentSessionList, GitlabMergeRequest } from "../../lib/wtsClient";
import {
  fakeWorkspaceClient,
  workspaceFixture,
  workspaceListFixture,
} from "../../test/workspaceClientFake";
import { LocalWorkspace } from "./LocalWorkspace";
import { assistantMaterialization } from "./localWorkspaceTestHelpers";

function setup() {
  const persisted = workspaceFixture({
    repositories: [{
      requestId: "repo_senzu",
      repositoryId: "repo_senzu",
      label: "senzu",
      baseRef: "develop",
      worktreeLeaf: "senzu",
    }],
    lifecycle: {
      materializationState: "materialized",
      worktreeCount: 1,
      observedAtUnixMs: 1_721_776_500_000,
    },
  });
  const materialization = assistantMaterialization(persisted);
  materialization.worktrees[0] = {
    ...materialization.worktrees[0]!,
    branchName: "wts/local-repositories-jellyfish-e2dfa9a6",
    gitState: {
      headCommitOid: "b".repeat(40),
      originUrl: "git@gitlab.example.com:sre-tools/senzu.git",
      upstreamFullRef: "refs/remotes/origin/develop",
    },
    activity: { changedFileCount: 119, commitsAhead: 3 },
  };
  const linked: GitlabMergeRequest = {
    id: "mr-43",
    repositoryId: "repo_senzu",
    iid: 43,
    projectPath: "sre-tools/senzu",
    webUrl: "https://gitlab.example.com/sre-tools/senzu/-/merge_requests/43",
    title: "Senzu flow",
    sourceBranch: "review/senzu-complete-flow",
    targetBranch: "develop",
    authorUsername: "nandan",
    updatedAt: "2026-09-22T12:00:00Z",
    draft: false,
    status: "open",
    sourceHeadCommitOid: "a".repeat(40),
  };
  const fake = fakeWorkspaceClient({
    list: workspaceListFixture([persisted]),
    persistedMaterialization: materialization,
  });
  const agentSessions: AgentSessionList = {
    schemaVersion: 1, sessions: [], observedSessions: [{
      schemaVersion: 1,
      sessionId: "22222222-2222-4222-8222-222222222222",
      workspaceId: persisted.workspaceId,
      provider: "codex", source: "codexVscodeRollout", status: "idle",
      activity: null, startedAtUnixMs: 1, lastEventAtUnixMs: Date.now(),
      mrLinkProposals: [{ schemaVersion: 1, repositoryId: "repo_senzu", iid: 43 }],
    }],
  };
  fake.listAgentSessions.mockResolvedValue(agentSessions);
  return { persisted, materialization, linked, fake };
}

describe("existing merge request linking", () => {
  it("shows the most recent agent hint for one repository", async () => {
    const user = userEvent.setup();
    const { persisted, fake } = setup();
    fake.listAgentSessions.mockResolvedValue({
      schemaVersion: 1, sessions: [], observedSessions: [
        {
          schemaVersion: 1, sessionId: "22222222-2222-4222-8222-222222222222",
          workspaceId: persisted.workspaceId, provider: "codex",
          source: "codexVscodeRollout", status: "idle", activity: null,
          startedAtUnixMs: 1, lastEventAtUnixMs: 100,
          mrLinkProposals: [{ schemaVersion: 1, repositoryId: "repo_senzu", iid: 43 }],
        },
        {
          schemaVersion: 1, sessionId: "33333333-3333-4333-8333-333333333333",
          workspaceId: persisted.workspaceId, provider: "codex",
          source: "codexVscodeRollout", status: "idle", activity: null,
          startedAtUnixMs: 2, lastEventAtUnixMs: 200,
          mrLinkProposals: [{ schemaVersion: 1, repositoryId: "repo_senzu", iid: 44 }],
        },
      ],
    });
    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
    expect(await screen.findByRole("button", { name: "Link agent MR !44" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Link agent MR !43" })).not.toBeInTheDocument();
  });

  it("does not show hints from another workspace or repository", async () => {
    const user = userEvent.setup();
    const { persisted, fake } = setup();
    fake.listAgentSessions.mockResolvedValue({
      schemaVersion: 1, sessions: [],
      observedSessions: [{
        schemaVersion: 1, sessionId: "22222222-2222-4222-8222-222222222222",
        workspaceId: "33333333-3333-4333-8333-333333333333",
        provider: "codex", source: "codexVscodeRollout", status: "idle",
        activity: null, startedAtUnixMs: 1, lastEventAtUnixMs: Date.now(),
        mrLinkProposals: [{ schemaVersion: 1, repositoryId: "repo_senzu", iid: 43 }],
      }, {
        schemaVersion: 1, sessionId: "44444444-4444-4444-8444-444444444444",
        workspaceId: persisted.workspaceId,
        provider: "codex", source: "codexVscodeRollout", status: "idle",
        activity: null, startedAtUnixMs: 1, lastEventAtUnixMs: Date.now(),
        mrLinkProposals: [{ schemaVersion: 1, repositoryId: "repo_other", iid: 43 }],
      }],
    });
    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
    await waitFor(() => expect(fake.listAgentSessions).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Link agent MR/ })).not.toBeInTheDocument();
    expect(fake.linkWorkspaceGitlabMergeRequest).not.toHaveBeenCalled();
  });

  it("lets the user replace a verified link without switching branches", async () => {
    const user = userEvent.setup();
    const { persisted, linked, fake } = setup();
    const replacement = { ...linked, id: "mr-44", iid: 44 };
    fake.getGitlabMergeRequests.mockResolvedValue({
      schemaVersion: 1, state: "fresh", mergeRequests: [linked],
      fetchedAtUnixMs: Date.now(), detail: "Linked MR.",
    });
    fake.linkWorkspaceGitlabMergeRequest.mockResolvedValue(replacement);
    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
    await user.click(screen.getByRole("button", { name: "Different branches" }));
    await user.click(await screen.findByRole("button", { name: "Change MR link" }));
    await user.type(screen.getByRole("textbox", { name: "MR number" }), "44");
    await user.click(screen.getByRole("button", { name: "Link MR" }));
    await waitFor(() => expect(fake.linkWorkspaceGitlabMergeRequest)
      .toHaveBeenCalledWith(persisted.workspaceId, "repo_senzu", 44));
    expect(await screen.findByRole("group", { name: "Linked MR !44 for senzu" }))
      .toHaveTextContent("Different branches");
    await waitFor(() => expect(screen.queryByRole("link", {
      name: /Open senzu merge request !43 on GitLab/,
    })).not.toBeInTheDocument());
  });

  it("links a verified MR by IID, refreshes the inbox, and keeps the managed branch", async () => {
    const user = userEvent.setup();
    const { persisted, materialization, linked, fake } = setup();
    fake.linkWorkspaceGitlabMergeRequest.mockResolvedValue(linked);
    fake.getGitlabMergeRequests.mockResolvedValueOnce({
      schemaVersion: 1, state: "fresh", mergeRequests: [],
      fetchedAtUnixMs: Date.now(), detail: "No exact branch match.",
    }).mockResolvedValue({
      schemaVersion: 1, state: "fresh", mergeRequests: [linked],
      fetchedAtUnixMs: Date.now(), detail: "Linked MR.",
    });
    fake.listWorkspaceWorkItemLinks.mockResolvedValue({
      schemaVersion: 1,
      workspaceId: persisted.workspaceId,
      links: [{
        linkId: "22222222-2222-4222-8222-222222222222",
        workspaceId: persisted.workspaceId,
        provider: "jira",
        role: "primary",
        snapshot: {
          issueKey: "PLATFORM-42",
          summary: "Senzu task",
          status: "In Progress",
          content: "Track Senzu.",
          fetchedAtUnixMs: Date.now(),
        },
        revision: 1,
        createdAtUnixMs: Date.now(),
        updatedAtUnixMs: Date.now(),
      }],
    });
    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
    await user.click(await screen.findByRole("button", { name: "Link agent MR !43" }));
    expect(screen.queryByRole("dialog", { name: /Find existing MR/ })).not.toBeInTheDocument();
    await waitFor(() => expect(fake.linkWorkspaceGitlabMergeRequest)
      .toHaveBeenCalledWith(persisted.workspaceId, "repo_senzu", 43));
    await waitFor(() => expect(fake.getGitlabMergeRequests).toHaveBeenCalledTimes(2));
    const localWork = screen.getByRole("group", { name: "Local work in senzu" });
    expect(localWork).toHaveTextContent("Local");
    expect(localWork).toHaveTextContent("119 changed files");
    const linkedMr = await screen.findByRole("group", { name: "Linked MR !43 for senzu" });
    expect(linkedMr).toHaveTextContent("Linked MR");
    expect(linkedMr).toHaveTextContent("Different branches");
    expect(within(linkedMr).getByRole("link", { name: /Open senzu merge request !43 on GitLab/ }))
      .toHaveTextContent("MR !43 · Open");
    expect(within(linkedMr).getByRole("link", { name: /Open senzu merge request !43 on GitLab/ }))
      .not.toHaveTextContent("Different branches");
    const branchToggle = within(linkedMr).getByRole("button", { name: "Different branches" });
    expect(branchToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/WTS does not compare or publish this MR from this worktree/)).not.toBeInTheDocument();
    await user.click(branchToggle);
    expect(branchToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/WTS does not compare or publish this MR from this worktree/)).toBeVisible();
    expect(linkedMr).toHaveTextContent("MRreview/senzu-complete-flow");
    expect(linkedMr).toHaveTextContent("Localwts/local-repositories-jellyfish-e2dfa9a6");
    expect(await screen.findByText("In Progress")).toBeVisible();
    expect(screen.queryByText("New local work")).not.toBeInTheDocument();
    expect(screen.queryByText("Workspace · MR !43")).not.toBeInTheDocument();
    expect(materialization.worktrees[0]?.branchName).toBe("wts/local-repositories-jellyfish-e2dfa9a6");
    expect(fake.prepareWorkspaceChangeRequest).not.toHaveBeenCalled();
    expect(fake.getWorkspaceGitlabComparison).not.toHaveBeenCalled();
    expect(fake.materializeWorkspace).not.toHaveBeenCalled();
    await user.click(screen.getByRole("link", { name: /Open senzu merge request !43 on GitLab/ }));
    await waitFor(() => expect(fake.openGitlabMergeRequest).toHaveBeenCalledWith("repo_senzu", 43));
  });

  it("shows provider failure and keeps the agent hint available", async () => {
    const user = userEvent.setup();
    const { persisted, linked, fake } = setup();
    fake.linkWorkspaceGitlabMergeRequest.mockRejectedValueOnce(new Error("GitLab could not find MR !43"))
      .mockResolvedValue(linked);
    fake.getGitlabMergeRequests.mockResolvedValue({
      schemaVersion: 1, state: "fresh", mergeRequests: [],
      fetchedAtUnixMs: Date.now(), detail: "No exact branch match.",
    });
    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
    await user.click(await screen.findByRole("button", { name: "Link agent MR !43" }));
    expect(await screen.findByText("GitLab could not find MR !43")).toBeVisible();
    expect(fake.linkWorkspaceGitlabMergeRequest).toHaveBeenCalledWith(persisted.workspaceId, "repo_senzu", 43);
    await user.click(screen.getByRole("button", { name: "Link agent MR !43" }));
    expect(await screen.findByRole("link", { name: /Open senzu merge request !43 on GitLab/ }))
      .toHaveTextContent("MR !43 · Open");
    expect(screen.getByRole("group", { name: "Linked MR !43 for senzu" }))
      .toHaveTextContent("Different branches");
  });

  it("keeps a confirmed link when the forced inbox refresh fails", async () => {
    const user = userEvent.setup();
    const { persisted, linked, fake } = setup();
    let rejectRefresh!: (cause: Error) => void;
    const refresh = new Promise<Awaited<ReturnType<typeof fake.client.getGitlabMergeRequests>>>(
      (_, reject) => { rejectRefresh = reject; },
    );
    fake.linkWorkspaceGitlabMergeRequest.mockResolvedValue(linked);
    fake.getGitlabMergeRequests.mockResolvedValueOnce({
      schemaVersion: 1, state: "fresh", mergeRequests: [],
      fetchedAtUnixMs: Date.now(), detail: "No exact branch match.",
    }).mockReturnValueOnce(refresh);
    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
    await user.click(await screen.findByRole("button", { name: "Link agent MR !43" }));
    await waitFor(() => expect(fake.linkWorkspaceGitlabMergeRequest)
      .toHaveBeenCalledWith(persisted.workspaceId, "repo_senzu", 43));
    await waitFor(() => expect(fake.getGitlabMergeRequests).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog", { name: "Find existing MR for senzu" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open senzu merge request !43 on GitLab/ }))
      .toHaveTextContent("MR !43 · Open");
    expect(screen.getByRole("group", { name: "Linked MR !43 for senzu" }))
      .toHaveTextContent("Different branches");
    rejectRefresh(new Error("GitLab unavailable"));
    expect(await screen.findByText("senzu · MR !43 linked. WTS could not refresh other MRs.")).toBeVisible();
    expect(screen.getByRole("link", { name: /Open senzu merge request !43 on GitLab/ })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Find existing MR for senzu" })).not.toBeInTheDocument();
  });
});
