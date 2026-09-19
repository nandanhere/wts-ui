import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import type { CloneRepositoryResult } from "../../lib/wtsClient";
import { fakeWorkspaceClient, repositoryCatalogFixture, runtimeAnalysisFixture } from "../../test/workspaceClientFake";
import { LocalWorkspace } from "./LocalWorkspace";

async function startBackgroundClone(options: { branch?: string; shallow?: boolean } = {}) {
  const user = userEvent.setup();
  const catalog = repositoryCatalogFixture();
  const local = catalog.repositories[0]!;
  const cloned = {
    ...local,
    id: "repo_large_clone",
    label: "large-service",
    checkoutLeaf: "large-service",
    displayPath: "~/cd/large-service",
  };
  let resolveClone!: (result: CloneRepositoryResult) => void;
  const pendingClone = new Promise<CloneRepositoryResult>((resolve) => {
    resolveClone = resolve;
  });
  const analysis = runtimeAnalysisFixture({
    services: [{
      candidateId: "candidate_checkout_api",
      serviceId: "checkout-api",
      displayName: "Checkout API",
      repositoryId: local.id,
      repositoryLabel: local.label,
      commitOid: local.defaultBranch.commitOid,
      workingDirectory: ".",
      command: ["npm", "run", "dev"],
      dependencies: [],
      ports: [{
        portId: "http",
        environment: "PORT",
        preferredPort: 3000,
        policy: "prefer",
        confidence: "declared",
        evidence: [],
      }],
      confidence: "declared",
      evidence: [],
      includedByDefault: true,
    }, {
      candidateId: "candidate_checkout_worker",
      serviceId: "checkout-worker",
      displayName: "Checkout Worker",
      repositoryId: local.id,
      repositoryLabel: local.label,
      commitOid: local.defaultBranch.commitOid,
      workingDirectory: ".",
      command: ["npm", "run", "worker"],
      dependencies: [],
      ports: [],
      confidence: "declared",
      evidence: [],
      includedByDefault: true,
    }],
  });
  const fake = fakeWorkspaceClient({ repositories: catalog, runtimeAnalysis: analysis });
  fake.cloneRepository.mockReturnValueOnce(pendingClone);
  render(<LocalWorkspace client={fake.client} />);
  await screen.findByRole("heading", { name: "No local workspaces found" });
  await user.click(screen.getAllByRole("button", { name: /New workspace/i })[0]!);
  const dialog = screen.getByRole("dialog", { name: "New workspace" });
  await user.click(within(dialog).getByRole("radio", { name: /^Repositories/i }));
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Repository to add" }), {
    target: { value: local.id },
  });
  await user.click(within(dialog).getByRole("button", { name: "Add repository" }));
  await user.click(within(dialog).getByRole("tab", { name: "Clone Git URL" }));
  await user.click(within(dialog).getByRole("textbox", { name: "Git repository URL" }));
  await user.paste("https://git.example.test/platform/large-service.git");
  if (options.branch) {
    await user.type(within(dialog).getByRole("textbox", { name: "Branch to clone" }), options.branch);
  }
  if (options.shallow === false) {
    await user.click(within(dialog).getByRole("checkbox", { name: /Limit the clone/i }));
  }
  await user.click(within(dialog).getByRole("button", { name: "Clone and add" }));
  const finishClone = async () => {
    await act(async () => {
      resolveClone({
        repository: cloned,
        repositoryRootDisplayPath: "~/cd",
        reusedExisting: false,
        ...(options.branch ? { selectedBaseRef: options.branch } : {}),
      });
      await pendingClone;
    });
  };
  const reviewServices = async (beforeReview?: () => Promise<void>) => {
    await user.click(within(dialog).getByRole("button", { name: /Analyze services/i }));
    await waitFor(() => expect(
      within(dialog).getByRole("button", { name: /Review plan/i }),
    ).toBeEnabled());
    await beforeReview?.();
    await user.click(within(dialog).getByRole("button", { name: /Review plan/i }));
  };
  const editServices = async () => {
    await user.click(within(dialog).getByRole("checkbox", {
      name: "Include Checkout Worker in runtime plan",
    }));
    fireEvent.change(within(dialog).getByRole("spinbutton", {
      name: "Preferred port for Checkout API http",
    }), { target: { value: "4100" } });
  };
  return { user, dialog, fake, local, cloned, analysis, finishClone, reviewServices, editServices };
}

it.each(["foreground", "Kanban"])("saves the requested full-clone branch after %s completion", async (completion) => {
  const branch = "release/2026.07";
  const { user, dialog, fake, cloned, finishClone } = await startBackgroundClone({ branch, shallow: false });
  expect(fake.cloneRepository).toHaveBeenCalledWith({
    remoteUrl: "https://git.example.test/platform/large-service.git",
    branch,
  });
  expect(cloned.defaultBranch.name).toBe("main");
  if (completion === "Kanban") {
    await user.click(within(dialog).getByRole("button", { name: "Move to Kanban" }));
  }
  await finishClone();
  if (completion === "Kanban") {
    await user.click(screen.getByRole("button", { name: "Continue setup" }));
  }
  const currentDialog = screen.getByRole("dialog", { name: "New workspace" });
  await user.click(within(currentDialog).getByRole("button", { name: /Review repositories/i }));
  await user.click(within(currentDialog).getByRole("button", { name: /Analyze services/i }));
  await waitFor(() => expect(within(currentDialog).getByRole("button", { name: /Review plan/i })).toBeEnabled());
  await user.click(within(currentDialog).getByRole("button", { name: /Review plan/i }));
  await user.click(within(currentDialog).getByRole("button", { name: /Save workspace plan/i }));
  expect(fake.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({
    repositories: expect.arrayContaining([
      { repositoryId: cloned.id, label: cloned.label, baseRef: branch },
    ]),
  }), expect.any(String));
});

it("preserves repository choices and plan settings across a deferred clone", async () => {
  const { user, dialog, local, cloned, finishClone, reviewServices, editServices } = await startBackgroundClone();
  await user.click(within(dialog).getByRole("button", { name: /Review repositories/i }));
  fireEvent.change(within(dialog).getByRole("combobox", { name: new RegExp(`^Base branch for ${local.label}`) }), {
    target: { value: "develop" },
  });
  await reviewServices(editServices);
  await user.click(within(dialog).getByRole("button", { name: /OpenCode/ }));
  await user.click(within(dialog).getByRole("radio", { name: /Create a starter kit/i }));
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Planning folder" }), {
    target: { value: "plans" },
  });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Planning starter" }), {
    target: { value: "notes" },
  });
  await user.click(within(dialog).getByRole("button", { name: "Source" }));
  await user.click(within(dialog).getByRole("button", { name: "Move to Kanban" }));
  await finishClone();
  await user.click(screen.getByRole("button", { name: "Continue setup" }));
  const resumed = screen.getByRole("dialog", { name: "New workspace" });
  const repositories = within(resumed).getByRole("list", { name: "Repositories in this workspace plan" });
  expect(repositories).toHaveTextContent(local.label);
  expect(repositories).toHaveTextContent(cloned.label);
  await user.click(within(resumed).getByRole("button", { name: /Review repositories/i }));
  expect(within(resumed).getByRole("combobox", { name: new RegExp(`^Base branch for ${local.label}`) })).toHaveValue("develop");
  await user.click(within(resumed).getByRole("button", { name: /Analyze services/i }));
  await waitFor(() => expect(within(resumed).getByRole("button", { name: /Review plan/i })).toBeEnabled());
  expect(within(resumed).getByRole("checkbox", { name: "Include Checkout Worker in runtime plan" })).not.toBeChecked();
  expect(within(resumed).getByRole("spinbutton", { name: "Preferred port for Checkout API http" })).toHaveValue(4100);
  await user.click(within(resumed).getByRole("button", { name: /Review plan/i }));
  expect(within(resumed).getByRole("button", { name: /OpenCode/ })).toHaveAttribute("aria-pressed", "true");
  expect(within(resumed).getByRole("radio", { name: /Create a starter kit/i })).toBeChecked();
  expect(within(resumed).getByRole("combobox", { name: "Planning folder" })).toHaveValue("plans");
  expect(within(resumed).getByRole("combobox", { name: "Planning starter" })).toHaveValue("notes");
});

it("starts a blank workspace after a resumed clone is canceled", async () => {
  const { user, dialog, finishClone } = await startBackgroundClone();
  await user.click(within(dialog).getByRole("button", { name: "Move to Kanban" }));
  await finishClone();
  await user.click(screen.getByRole("button", { name: "Continue setup" }));
  await user.click(screen.getByRole("button", { name: "Close new workspace" }));
  await user.click(screen.getAllByRole("button", { name: /New workspace/i })[0]!);
  const next = screen.getByRole("dialog", { name: "New workspace" });
  expect(within(next).getByRole("radio", { name: /^Issue/i })).toBeChecked();
  expect(within(next).queryByRole("list", { name: "Repositories in this workspace plan" })).not.toBeInTheDocument();
});

it("requires service review after a clone completes at the final plan", async () => {
  const { user, dialog, fake, cloned, finishClone, reviewServices, editServices } = await startBackgroundClone();
  await user.click(within(dialog).getByRole("button", { name: /Review repositories/i }));
  await user.click(within(dialog).getByRole("button", { name: /Analyze services/i }));
  await waitFor(() => expect(within(dialog).getByRole("button", { name: /Review plan/i })).toBeEnabled());
  expect(within(dialog).getByRole("checkbox", { name: "Include Checkout API in runtime plan" })).toBeChecked();
  await editServices();
  await user.click(within(dialog).getByRole("button", { name: /Review plan/i }));
  expect(within(dialog).getByRole("button", { name: /Save workspace plan/i })).toBeDisabled();
  await finishClone();
  expect(within(dialog).queryByRole("button", { name: /Save workspace plan/i })).not.toBeInTheDocument();
  expect(within(dialog).getByRole("combobox", { name: new RegExp(`^Base branch for ${cloned.label}`) })).toBeVisible();
  expect(fake.createWorkspace).not.toHaveBeenCalled();
  await reviewServices();
  expect(fake.analyzeWorkspaceRuntime).toHaveBeenCalledTimes(2);
  expect(within(dialog).getByRole("button", { name: "Repositories" })).toBeEnabled();
  await user.click(within(dialog).getByRole("button", { name: /Save workspace plan/i }));
  expect(fake.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({
    runtime: expect.objectContaining({
      services: [{
        candidateId: "candidate_checkout_api",
        ports: [{ portId: "http", preferredPort: 4100, policy: "prefer" }],
      }],
    }),
  }), expect.any(String));
});

it("detaches a pending clone when the user changes the workspace source", async () => {
  const { user, dialog, fake, local, cloned, finishClone, reviewServices } = await startBackgroundClone();
  await user.click(within(dialog).getByRole("radio", { name: /^Issue/i }));
  await user.type(within(dialog).getByRole("textbox", { name: /Jira issue key or URL/i }), "PORT-42");
  await user.type(within(dialog).getByRole("textbox", { name: "Repositories for this plan" }), local.label);
  await user.click(within(dialog).getByRole("button", { name: /Review repositories/i }));
  await reviewServices();
  expect(within(dialog).getByRole("button", { name: /Save workspace plan/i })).toBeEnabled();
  await finishClone();
  expect(within(dialog).queryByText(cloned.label)).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: /Save workspace plan/i }));
  expect(fake.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({
    intent: { type: "jira", issueKey: "PORT-42" },
    repositories: [{ repositoryId: local.id, label: local.label, baseRef: "main" }],
  }), expect.any(String));
});

it("uses new service defaults when reanalysis changes the repository commit", async () => {
  const { user, dialog, fake, analysis, finishClone, reviewServices, editServices } = await startBackgroundClone();
  await user.click(within(dialog).getByRole("button", { name: /Review repositories/i }));
  await reviewServices(editServices);
  fake.analyzeWorkspaceRuntime.mockResolvedValueOnce({
    ...analysis,
    services: analysis.services.map((service) => ({
      ...service,
      commitOid: "1123456789abcdef0123456789abcdef01234567",
    })),
  });
  await finishClone();
  await user.click(within(dialog).getByRole("button", { name: /Analyze services/i }));
  await waitFor(() => expect(within(dialog).getByRole("button", { name: /Review plan/i })).toBeEnabled());
  expect(within(dialog).getByRole("checkbox", { name: "Include Checkout Worker in runtime plan" })).toBeChecked();
  expect(within(dialog).getByRole("spinbutton", { name: "Preferred port for Checkout API http" })).toHaveValue(3000);
});
