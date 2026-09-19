import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  JiraCreateProposal,
  WorkspaceWorkItemLink,
  WorkspaceWorkItemLinkPreview,
  WorkspaceWorkItemRole,
} from "../../lib/wtsClient";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import { WorkspaceClientError } from "../../lib/wtsClient";
import { WorkspaceWorkItemsPanel } from "./WorkspaceWorkItemsPanel";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const workspaceKey = "infra · revised · copy";
const linkId = "22222222-2222-4222-8222-222222222222";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const previewDigest = `sha256:${"a".repeat(64)}`;

function jiraPreview(
  issueKey = "PLATFORM-42",
  role: WorkspaceWorkItemRole = "primary",
  browserUrl: string | undefined =
    "https://jira.example.test/browse/PLATFORM-42",
): WorkspaceWorkItemLinkPreview {
  return {
    schemaVersion: 1,
    workspaceId,
    provider: "jira",
    role,
    snapshot: {
      issueKey,
      summary: `Summary for ${issueKey}`,
      status: "In Progress",
      content: `Exact imported content for ${issueKey}.`,
      ...(browserUrl ? { browserUrl } : {}),
      fetchedAtUnixMs: 1_786_512_000_000,
    },
    previewDigest,
  };
}

function linkedItem(
  preview = jiraPreview(),
  revision = 7,
): WorkspaceWorkItemLink {
  return {
    linkId,
    workspaceId,
    provider: "jira",
    role: preview.role,
    snapshot: preview.snapshot,
    revision,
    createdAtUnixMs: 1_786_512_000_000,
    updatedAtUnixMs: 1_786_512_000_000,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("WorkspaceWorkItemsPanel", () => {
  it("offers Jira connection settings after a preview configuration failure", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    fake.previewWorkspaceJiraLink.mockRejectedValue(new WorkspaceClientError("Configure Jira MCP.", { code: "jira_mcp_configuration_invalid" }));
    const onOpenIntegrations = vi.fn();
    render(<WorkspaceWorkItemsPanel client={fake.client} workspaceId={workspaceId} workspaceKey={workspaceKey} onOpenIntegrations={onOpenIntegrations} />);
    await user.click(screen.getByRole("button", { name: "Add Jira" }));
    await user.type(screen.getByRole("textbox", { name: "Jira issue key" }), "PLATFORM-42");
    await user.click(screen.getByRole("button", { name: "Preview Jira issue" }));
    await user.click(await screen.findByRole("button", { name: "Check Jira connection" }));
    expect(onOpenIntegrations).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "Jira issue key" })).toHaveValue("PLATFORM-42");
  });

  it("refreshes a stale link preview before another explicit link action", async () => {
    const user = userEvent.setup();
    vi.mocked(crypto.randomUUID).mockReturnValueOnce(idempotencyKey).mockReturnValueOnce("44444444-4444-4444-8444-444444444444");
    const fake = fakeWorkspaceClient();
    const latest = { ...jiraPreview(), previewDigest: `sha256:${"b".repeat(64)}` };
    fake.previewWorkspaceJiraLink.mockResolvedValueOnce(jiraPreview()).mockResolvedValueOnce(latest);
    fake.confirmWorkspaceJiraLink.mockRejectedValueOnce(new WorkspaceClientError("The issue changed.", { code: "stale_work_item_link_preview" })).mockResolvedValueOnce({ link: linkedItem(latest), replayed: false });
    render(<WorkspaceWorkItemsPanel client={fake.client} workspaceId={workspaceId} workspaceKey={workspaceKey} />);
    await user.click(screen.getByRole("button", { name: "Add Jira" }));
    await user.type(screen.getByRole("textbox", { name: "Jira issue key" }), "PLATFORM-42");
    await user.click(screen.getByRole("button", { name: "Preview Jira issue" }));
    await user.click(await screen.findByRole("button", { name: "Link Jira issue" }));
    await user.click(await screen.findByRole("button", { name: "Refresh Jira preview" }));
    await waitFor(() => expect(fake.previewWorkspaceJiraLink).toHaveBeenCalledTimes(2));
    expect(fake.confirmWorkspaceJiraLink).toHaveBeenCalledOnce();
    await user.click(await screen.findByRole("button", { name: "Link Jira issue" }));
    expect(fake.confirmWorkspaceJiraLink.mock.calls[1]?.[3]).toBe(latest.previewDigest);
    expect(fake.confirmWorkspaceJiraLink.mock.calls[1]?.[4]).not.toBe(fake.confirmWorkspaceJiraLink.mock.calls[0]?.[4]);
  });

  it("refreshes an obsolete linked issue before another explicit open action", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceWorkItemLinks.mockResolvedValueOnce({ schemaVersion: 1, workspaceId, links: [linkedItem()] }).mockResolvedValueOnce({ schemaVersion: 1, workspaceId, links: [linkedItem(jiraPreview(), 8)] });
    fake.openWorkspaceWorkItem.mockRejectedValueOnce(new WorkspaceClientError("The linked issue changed.", { code: "work_item_link_conflict" }));
    render(<WorkspaceWorkItemsPanel client={fake.client} workspaceId={workspaceId} workspaceKey={workspaceKey} />);
    await user.click(await screen.findByRole("link", { name: /^Open Jira issue PLATFORM-42:/ }));
    await user.click(await screen.findByRole("button", { name: "Refresh linked issues" }));
    await waitFor(() => expect(fake.listWorkspaceWorkItemLinks).toHaveBeenCalledTimes(2));
    expect(fake.openWorkspaceWorkItem).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("link", { name: /^Open Jira issue PLATFORM-42:/ }));
    expect(fake.openWorkspaceWorkItem).toHaveBeenLastCalledWith(workspaceId, linkId, 8);
  });

  it("refreshes after an unlink conflict without repeating the mutation", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceWorkItemLinks.mockResolvedValueOnce({ schemaVersion: 1, workspaceId, links: [linkedItem()] }).mockResolvedValueOnce({ schemaVersion: 1, workspaceId, links: [] });
    fake.unlinkWorkspaceWorkItem.mockRejectedValue(new WorkspaceClientError("The linked issue changed.", { code: "work_item_link_conflict" }));
    render(<WorkspaceWorkItemsPanel client={fake.client} workspaceId={workspaceId} workspaceKey={workspaceKey} />);
    await user.click(await screen.findByRole("button", { name: "More actions for PLATFORM-42" }));
    await user.click(await screen.findByRole("menuitem", { name: "Unlink Jira issue…" }));
    await user.click(screen.getByRole("checkbox", { name: "I understand that this removes only the link." }));
    await user.click(screen.getByRole("button", { name: "Unlink Jira" }));
    await user.click(await screen.findByRole("button", { name: "Refresh linked issues" }));
    expect(await screen.findByText("No Jira issue is linked to this workspace.")).toBeVisible();
    expect(fake.unlinkWorkspaceWorkItem).toHaveBeenCalledOnce();
  });

  it("keeps a Jira proposal available for manual copy after clipboard failure", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Clipboard blocked"));
    fake.proposeWorkspaceJiraIssue.mockResolvedValue({ schemaVersion: 1, workspaceId, summary: "Preserve this summary", description: "Preserve the reviewed requirements.", sourceDocumentSha256: `sha256:${"b".repeat(64)}`, canExecute: false, requiresExplicitApproval: true, detail: "Create this issue manually in Jira." });
    render(<WorkspaceWorkItemsPanel client={fake.client} workspaceId={workspaceId} workspaceKey={workspaceKey} />);
    await user.click(screen.getByRole("button", { name: "More work item actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Draft a Jira issue…" }));
    await user.click(screen.getByRole("button", { name: "Prepare draft" }));
    await user.click(await screen.findByRole("button", { name: "Copy draft" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Clipboard access failed. Select and copy the summary and description below.");
    expect(screen.getByRole("textbox", { name: "Summary" })).toHaveValue("Preserve this summary");
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("Preserve the reviewed requirements.");
    expect(fake.proposeWorkspaceJiraIssue).toHaveBeenCalledOnce();
  });

  it("refreshes a stale Jira preview without automatically opening or linking it", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    fake.previewWorkspaceJiraLink.mockResolvedValue(jiraPreview());
    fake.openWorkspaceJiraPreview.mockRejectedValue(new WorkspaceClientError("The issue changed.", { code: "stale_work_item_link_preview" }));
    render(<WorkspaceWorkItemsPanel client={fake.client} workspaceId={workspaceId} workspaceKey={workspaceKey} />);
    await user.click(screen.getByRole("button", { name: "Add Jira" }));
    await user.type(screen.getByRole("textbox", { name: "Jira issue key" }), "PLATFORM-42");
    await user.click(screen.getByRole("button", { name: "Preview Jira issue" }));
    await user.click(await screen.findByRole("link", { name: "Open Jira" }));
    await user.click(await screen.findByRole("button", { name: "Refresh Jira preview" }));
    await waitFor(() => expect(fake.previewWorkspaceJiraLink).toHaveBeenCalledTimes(2));
    expect(fake.openWorkspaceJiraPreview).toHaveBeenCalledOnce();
    expect(fake.confirmWorkspaceJiraLink).not.toHaveBeenCalled();
  });

  it("shows workspace merge request delivery beside linked work item status", async () => {
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceWorkItemLinks.mockResolvedValue({
      schemaVersion: 1,
      workspaceId,
      links: [linkedItem(jiraPreview("PLATFORM-42", "primary"))],
    });

    render(
      <WorkspaceWorkItemsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey={workspaceKey}
        deliveryLabel="Workspace · MR !42"
      />,
    );

    expect(await screen.findByText("Workspace · MR !42")).toBeVisible();
    expect(screen.getByText("In Progress")).toBeVisible();
  });
  beforeEach(() => {
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => idempotencyKey),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("previews exact Jira content before confirmation and reuses its retry key", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    const preview = jiraPreview();
    const link = linkedItem(preview);
    const onNotice = vi.fn();
    fake.listWorkspaceWorkItemLinks.mockResolvedValue({
      schemaVersion: 1,
      workspaceId,
      links: [],
    });
    fake.previewWorkspaceJiraLink.mockResolvedValue(preview);
    fake.openWorkspaceJiraPreview.mockResolvedValue({
      workspaceId,
      issueKey: "PLATFORM-42",
      accepted: true,
    });
    fake.confirmWorkspaceJiraLink
      .mockRejectedValueOnce(new Error("The connection ended after confirmation."))
      .mockResolvedValueOnce({ link, replayed: true });

    render(
      <WorkspaceWorkItemsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey={workspaceKey}
        onNotice={onNotice}
      />,
    );

    await screen.findByText("No Jira issue is linked to this workspace.");
    await user.click(screen.getByRole("button", { name: "Add Jira" }));
    const issueInput = screen.getByRole("textbox", { name: "Jira issue key" });
    expect(issueInput).toHaveFocus();
    await user.type(issueInput, "PLATFORM-42");
    await user.click(screen.getByRole("button", { name: "Preview Jira issue" }));

    expect(fake.confirmWorkspaceJiraLink).not.toHaveBeenCalled();
    expect(await screen.findByText("Summary for PLATFORM-42")).toBeVisible();
    expect(screen.getByText("In Progress")).toBeVisible();
    expect(screen.getByText("Exact imported content for PLATFORM-42.")).toBeVisible();
    const previewLink = screen.getByRole("link", { name: "Open Jira" });
    expect(previewLink).toHaveAttribute(
      "href",
      "https://jira.example.test/browse/PLATFORM-42",
    );
    await user.click(previewLink);
    expect(fake.openWorkspaceJiraPreview).toHaveBeenCalledWith(
      workspaceId,
      "PLATFORM-42",
      "primary",
      previewDigest,
    );

    await user.click(screen.getByRole("button", { name: "Link Jira issue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The connection ended after confirmation.",
    );
    await user.click(screen.getByRole("button", { name: "Link Jira issue" }));

    await waitFor(() => expect(fake.confirmWorkspaceJiraLink).toHaveBeenCalledTimes(2));
    expect(fake.confirmWorkspaceJiraLink.mock.calls).toEqual([
      [workspaceId, "PLATFORM-42", "primary", previewDigest, idempotencyKey],
      [workspaceId, "PLATFORM-42", "primary", previewDigest, idempotencyKey],
    ]);
    expect(onNotice).toHaveBeenCalledWith(
      "PLATFORM-42 linked to infra · revised · copy",
    );
  });

  it("shows only safe Jira browser links", async () => {
    const unsafePreview = jiraPreview(
      "PLATFORM-9999",
      "related",
      "javascript:alert(document.domain)",
    );
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceWorkItemLinks.mockResolvedValue({
      schemaVersion: 1,
      workspaceId,
      links: [linkedItem(unsafePreview)],
    });

    render(
      <WorkspaceWorkItemsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey={workspaceKey}
      />,
    );

    expect(await screen.findByText("PLATFORM-9999")).toBeVisible();
    expect(screen.getByText("Summary for PLATFORM-9999")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /Open Jira issue/ }),
    ).not.toBeInTheDocument();
  });

  it("shows a real Jira link when the configured site has a path prefix", async () => {
    const user = userEvent.setup();
    const preview = jiraPreview(
      "PLATFORM-42",
      "primary",
      "https://jira.example/products/jira/browse/PLATFORM-42",
    );
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceWorkItemLinks.mockResolvedValue({
      schemaVersion: 1,
      workspaceId,
      links: [linkedItem(preview)],
    });
    fake.openWorkspaceWorkItem.mockResolvedValue({
      workspaceId,
      issueKey: "PLATFORM-42",
      accepted: true,
    });

    render(
      <WorkspaceWorkItemsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey={workspaceKey}
      />,
    );

    const jiraLink = await screen.findByRole("link", {
      name: "Open Jira issue PLATFORM-42: Summary for PLATFORM-42",
    });
    expect(jiraLink).toHaveAttribute(
      "href",
      "https://jira.example/products/jira/browse/PLATFORM-42",
    );
    await user.click(jiraLink);
    expect(fake.openWorkspaceWorkItem).toHaveBeenCalledWith(workspaceId, linkId, 7);
  });

  it("removes old Jira actions while the next workspace links load", async () => {
    const nextWorkspaceId = "44444444-4444-4444-8444-444444444444";
    const nextLinks = deferred<{
      schemaVersion: 1;
      workspaceId: string;
      links: WorkspaceWorkItemLink[];
    }>();
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceWorkItemLinks
      .mockResolvedValueOnce({
        schemaVersion: 1,
        workspaceId,
        links: [linkedItem()],
      })
      .mockReturnValueOnce(nextLinks.promise);

    const view = render(
      <WorkspaceWorkItemsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey={workspaceKey}
      />,
    );

    expect(await screen.findByText("PLATFORM-42")).toBeVisible();
    expect(
      screen.getByRole("link", {
        name: "Open Jira issue PLATFORM-42: Summary for PLATFORM-42",
      }),
    ).toBeVisible();

    view.rerender(
      <WorkspaceWorkItemsPanel
        client={fake.client}
        workspaceId={nextWorkspaceId}
        workspaceKey="payments · follow-up"
      />,
    );

    expect(screen.queryByText("PLATFORM-42")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Open Jira issue/ }),
    ).not.toBeInTheDocument();
    expect(fake.listWorkspaceWorkItemLinks).toHaveBeenLastCalledWith(
      nextWorkspaceId,
    );

    await act(async () => {
      nextLinks.resolve({
        schemaVersion: 1,
        workspaceId: nextWorkspaceId,
        links: [],
      });
    });
    expect(
      await screen.findByText("No Jira issue is linked to this workspace."),
    ).toBeVisible();
    expect(fake.openWorkspaceWorkItem).not.toHaveBeenCalled();
  });

  it("uses a compact, link-free state with one Add Jira action", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceWorkItemLinks.mockResolvedValue({
      schemaVersion: 1,
      workspaceId,
      links: [],
    });

    render(
      <WorkspaceWorkItemsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey={workspaceKey}
      />,
    );

    const emptyMessage = await screen.findByText(
      "No Jira issue is linked to this workspace.",
    );
    const panel = emptyMessage.closest("section");
    expect(panel).toHaveAttribute("data-compact", "true");
    expect(
      screen.queryByText(
        "Link Jira issues without changing the workspace source or Git branches.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add Jira" })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Add Jira" }));
    expect(panel).not.toHaveAttribute("data-compact");
    expect(
      screen.getByRole("heading", { name: "Link a Jira issue" }),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Close Jira link form" }),
    );
    expect(panel).toHaveAttribute("data-compact", "true");
  });

  it("keeps linked work items compact until an inline action expands", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    const link = linkedItem();
    fake.listWorkspaceWorkItemLinks.mockResolvedValue({
      schemaVersion: 1,
      workspaceId,
      links: [link],
    });

    render(
      <WorkspaceWorkItemsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey={workspaceKey}
      />,
    );

    const linkedList = await screen.findByRole("table", {
      name: "Linked work items",
    });
    const panel = linkedList.closest("section");
    expect(panel).toHaveAttribute("data-compact", "true");
    expect(
      screen.getAllByRole("columnheader").map((cell) => cell.textContent),
    ).toEqual(["Issue", "Status", "Relationship", ""]);
    expect(screen.queryByText("Open Jira")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "More actions for PLATFORM-42" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Unlink Jira issue…" }),
    );
    expect(panel).not.toHaveAttribute("data-compact");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(panel).toHaveAttribute("data-compact", "true");
  });

  it("requires explicit unlink confirmation and sends the current revision", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    const link = linkedItem(jiraPreview(), 7);
    fake.listWorkspaceWorkItemLinks.mockResolvedValue({
      schemaVersion: 1,
      workspaceId,
      links: [link],
    });
    fake.unlinkWorkspaceWorkItem.mockResolvedValue({
      workspaceId,
      linkId,
      removedRevision: 7,
    });

    render(
      <WorkspaceWorkItemsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey={workspaceKey}
      />,
    );

    await screen.findByTestId(`work-item-${linkId}`);
    expect(
      screen.queryByRole("menuitem", { name: "Unlink Jira issue…" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "More actions for PLATFORM-42" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Unlink Jira issue…" }),
    );
    const confirmButton = screen.getByRole("button", { name: "Unlink Jira" });
    expect(confirmButton).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", {
        name: "I understand that this removes only the link.",
      }),
    );
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);

    await waitFor(() => {
      expect(fake.unlinkWorkspaceWorkItem).toHaveBeenCalledWith(
        workspaceId,
        linkId,
        7,
      );
    });
    expect(screen.queryByTestId(`work-item-${linkId}`)).not.toBeInTheDocument();
  });

  it("keeps Jira issue drafting compact until the user opens it", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    const onNotice = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const proposal: JiraCreateProposal = {
      schemaVersion: 1,
      workspaceId,
      summary: "Create the release guard",
      description: "Use the approved workspace requirements.",
      sourceDocumentSha256: `sha256:${"b".repeat(64)}`,
      canExecute: false,
      requiresExplicitApproval: true,
      detail: "No safe Jira create adapter is available.",
    };
    fake.listWorkspaceWorkItemLinks.mockResolvedValue({
      schemaVersion: 1,
      workspaceId,
      links: [],
    });
    fake.proposeWorkspaceJiraIssue.mockResolvedValue(proposal);

    render(
      <WorkspaceWorkItemsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey={workspaceKey}
        onNotice={onNotice}
      />,
    );

    const emptyState = await screen.findByText(
      "No Jira issue is linked to this workspace.",
    );
    expect(emptyState.tagName).toBe("P");
    expect(
      screen.queryByRole("heading", { name: "Draft a Jira issue" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Prepare draft" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "More work item actions" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Draft a Jira issue…" }),
    );
    expect(
      screen.getByRole("heading", { name: "Draft a Jira issue" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Prepare draft" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "WTS cannot create this issue.",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "No safe Jira create adapter is available.",
    );
    expect(screen.getByRole("textbox", { name: "Summary" })).toHaveValue(
      proposal.summary,
    );
    expect(screen.getByRole("textbox", { name: "Summary" })).toHaveAttribute(
      "readonly",
    );
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
      proposal.description,
    );
    expect(
      screen.queryByRole("button", { name: "Create Jira issue" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy draft" }));
    expect(writeText).toHaveBeenCalledWith(
      "Create the release guard\n\nUse the approved workspace requirements.",
    );
    expect(onNotice).toHaveBeenCalledWith("Jira draft copied");
    await user.click(
      screen.getByRole("button", { name: "Close Jira issue draft" }),
    );
    expect(
      screen.queryByRole("heading", { name: "Draft a Jira issue" }),
    ).not.toBeInTheDocument();
  });

  it("ignores a preview response after the issue key changes", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    const oldRequest = deferred<WorkspaceWorkItemLinkPreview>();
    const newRequest = deferred<WorkspaceWorkItemLinkPreview>();
    fake.listWorkspaceWorkItemLinks.mockResolvedValue({
      schemaVersion: 1,
      workspaceId,
      links: [],
    });
    fake.previewWorkspaceJiraLink
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);

    render(
      <WorkspaceWorkItemsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey={workspaceKey}
      />,
    );

    await screen.findByText("No Jira issue is linked to this workspace.");
    await user.click(screen.getByRole("button", { name: "Add Jira" }));
    const issueInput = screen.getByRole("textbox", { name: "Jira issue key" });
    await user.type(issueInput, "OLD-1");
    await user.click(screen.getByRole("button", { name: "Preview Jira issue" }));
    await user.clear(issueInput);
    await user.type(issueInput, "NEW-2");
    await user.click(screen.getByRole("button", { name: "Preview Jira issue" }));

    await act(async () => {
      newRequest.resolve(jiraPreview("NEW-2"));
    });
    expect(await screen.findByText("Summary for NEW-2")).toBeVisible();
    await act(async () => {
      oldRequest.resolve(jiraPreview("OLD-1"));
    });
    expect(screen.queryByText("Summary for OLD-1")).not.toBeInTheDocument();
    expect(screen.getByText("Summary for NEW-2")).toBeVisible();
  });
});
