import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type WorkspacePlanningDocument,
  type WorkspaceReviewThread,
  WorkspaceClientError,
} from "../../lib/wtsClient";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import { PlanningDocumentsPanel } from "./PlanningDocumentsPanel";
import { planningViewFor, rememberPlanningView } from "./planningWorkspaceCache";

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: mermaidMocks,
}));

const workspaceId = "ws_01J_PLANNING";

beforeEach(() => {
  localStorage.removeItem("wts.planning-file-states.v1");
  mermaidMocks.initialize.mockClear();
  mermaidMocks.render.mockReset();
  mermaidMocks.render.mockResolvedValue({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Rendered</text></svg>',
  });
});

function reviewThread(
  overrides: Partial<WorkspaceReviewThread> & {
    threadId: string;
    body: string;
  },
): WorkspaceReviewThread {
  const { body, threadId, ...threadOverrides } = overrides;
  return {
    threadId,
    workspaceId,
    target: {
      kind: "planningDocument",
      documentId: "plan",
      documentSha256: `sha256:${"a".repeat(64)}`,
      line: 3,
    },
    anchorState: "current",
    currentDocumentSha256: `sha256:${"a".repeat(64)}`,
    state: "open",
    revision: 4,
    comments: [
      {
        commentId: `${threadId}-comment`,
        author: "user",
        body,
        createdAtUnixMs: 1_720_000_000_000,
      },
    ],
    createdAtUnixMs: 1_720_000_000_000,
    updatedAtUnixMs: 1_720_000_000_100,
    ...threadOverrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function planningDocument(
  documentId: WorkspacePlanningDocument["documentId"],
  contents: string,
  digestCharacter = "a",
): WorkspacePlanningDocument {
  return {
    workspaceId,
    documentId,
    fileName: `/private/workspace/plans/${documentId}.md`,
    contents,
    sha256: `sha256:${digestCharacter.repeat(64)}`,
  };
}

function planningClient() {
  const fake = fakeWorkspaceClient();
  const listWorkspacePlanningDocuments = vi
    .fn()
    .mockResolvedValue({
      workspaceId,
      documents: [
        { documentId: "readme", fileName: "/private/workspace/README.md" },
        { documentId: "findings", fileName: "/private/workspace/FINDINGS.md" },
        { documentId: "kanban", fileName: "/private/workspace/KANBAN.md" },
        { documentId: "plan", fileName: "/private/workspace/PLAN.md" },
      ],
    });
  const readWorkspacePlanningDocument = vi
    .fn()
    .mockImplementation(
      async (_workspaceId: string, documentId: WorkspacePlanningDocument["documentId"]) =>
        planningDocument(
          documentId,
          documentId === "plan"
            ? "# Plan\n\n- [ ] Confirm the retry rule.\n\n> User decision"
            : `# ${documentId}\n\nFull ${documentId} contents`,
        ),
    );
  const updateWorkspacePlanningDocument = vi.fn();
  const listWorkspaceReviewThreads = vi.fn().mockResolvedValue({
    workspaceId,
    threads: [],
  });
  const createWorkspaceReviewThread = vi.fn();
  const resolveWorkspaceReviewThread = vi.fn();
  Object.assign(fake.client, {
    listWorkspacePlanningDocuments,
    readWorkspacePlanningDocument,
    updateWorkspacePlanningDocument,
    listWorkspaceReviewThreads,
    createWorkspaceReviewThread,
    resolveWorkspaceReviewThread,
  });
  return {
    ...fake,
    listWorkspacePlanningDocuments,
    readWorkspacePlanningDocument,
    updateWorkspacePlanningDocument,
    listWorkspaceReviewThreads,
    createWorkspaceReviewThread,
    resolveWorkspaceReviewThread,
  };
}

describe("PlanningDocumentsPanel", () => {
  it("keeps known native previews out of edit mode", async () => {
    const fake = planningClient();
    Object.defineProperty(window, "__WTS_NATIVE_PREVIEW__", { configurable: true, value: { schemaVersion: 1, allowedCommands: ["read_workspace_planning_document"] } });
    try {
      render(<PlanningDocumentsPanel client={fake.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />);
      await screen.findByRole("article", { name: "PLAN.md preview" });
      expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
      expect(screen.getByText("This preview is read-only. Use the main WTS window to make changes.")).toBeVisible();
      expect(fake.updateWorkspacePlanningDocument).not.toHaveBeenCalled();
    } finally { Reflect.deleteProperty(window, "__WTS_NATIVE_PREVIEW__"); }
  });

  it.each(["preview_read_only", "native_preview_read_only"])("keeps a rejected preview draft copyable without a write retry for %s", async code => {
    const user = userEvent.setup(); const fake = planningClient();
    fake.updateWorkspacePlanningDocument.mockRejectedValue(new WorkspaceClientError("Native preview rejected this write.", { code }));
    render(<PlanningDocumentsPanel client={fake.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Edit PLAN.md" });
    fireEvent.change(editor, { target: { value: "# Keep this preview draft" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("This preview is read-only. Use the main WTS window to make changes.");
    expect(screen.queryByRole("button", { name: "Try save again" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(editor).toHaveValue("# Keep this preview draft");
    expect(editor).toHaveAttribute("readonly");
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    await user.click(screen.getByRole("button", { name: "Copy draft" }));
    expect(await navigator.clipboard.readText()).toBe("# Keep this preview draft");
    expect(fake.updateWorkspacePlanningDocument).toHaveBeenCalledOnce();
  });

  it("keeps newer feedback text and one POST while the submitted feedback is pending", async () => {
    const user = userEvent.setup(); const fake = planningClient(); const pending = deferred<WorkspaceReviewThread>(); fake.createWorkspaceReviewThread.mockReturnValue(pending.promise);
    render(<PlanningDocumentsPanel client={fake.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />); await user.click(await screen.findByRole("button", { name: "Source" }));
    const input = screen.getByRole("textbox", { name: "Feedback for PLAN.md" }); fireEvent.change(input, { target: { value: "First question" } }); await user.click(screen.getByRole("button", { name: "Add feedback" }));
    fireEvent.change(input, { target: { value: "Keep this newer question" } }); fireEvent.keyDown(input, { key: "Enter", ctrlKey: true }); expect(fake.createWorkspaceReviewThread).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(reviewThread({ threadId: "first-feedback", body: "First question" })); await pending.promise; });
    expect(input).toHaveValue("Keep this newer question"); expect(planningViewFor(fake.client, workspaceId)?.feedbackDraft).toBe("Keep this newer question"); expect(screen.getByRole("button", { name: "Add feedback" })).toBeEnabled();
  });

  it.each(["flat", "fields"])("renders an imported Jira %s description while source, edits, and feedback retain the original file", async (shape) => {
    const user = userEvent.setup();
    const fake = planningClient();
    const description = "Check the retry rule.\n\n- Keep the current limit.\n- Add a regression test.\n\nUse `<Result<T>>` in the example.";
    const envelope = JSON.stringify(shape === "flat"
      ? { issue_key: "PLATFORM-42", description }
      : { key: "PLATFORM-42", fields: { description } });
    const contents = `# Plan\n\n## Jira context\n\n- Issue: \`PLATFORM-42\`\n- Summary: Retry rule\n- Status: Open\n\n### Imported description\n\n${envelope}\n\n## Objective\n\nKeep this objective.\n`;
    fake.readWorkspacePlanningDocument.mockResolvedValue(planningDocument("plan", contents));
    fake.createWorkspaceReviewThread.mockResolvedValue(reviewThread({ threadId: "import-feedback", body: "Check the imported evidence." }));
    render(<PlanningDocumentsPanel client={fake.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />);

    const preview = await screen.findByRole("article", { name: "PLAN.md preview" });
    expect(within(preview).getByText("Check the retry rule.").tagName).toBe("P");
    expect(within(preview).getByText("Keep the current limit.").tagName).toBe("LI");
    expect(within(preview).getByText("<Result<T>>").tagName).toBe("CODE");
    expect(within(preview).getByText("Keep this objective.")).toBeVisible();
    expect(preview).not.toHaveTextContent(envelope);

    await user.click(screen.getByRole("button", { name: "Source" }));
    const source = screen.getByRole("region", { name: "PLAN.md contents" });
    expect(Array.from(source.querySelectorAll("code"), (line) => line.textContent === "\u00a0" ? "" : line.textContent).join("\n")).toBe(contents);
    await user.click(within(source).getByRole("button", { name: `Line 11: ${envelope}` }));
    await user.type(screen.getByRole("textbox", { name: "Feedback for PLAN.md" }), "Check the imported evidence.");
    await user.click(screen.getByRole("button", { name: "Add feedback" }));
    await waitFor(() => expect(fake.createWorkspaceReviewThread).toHaveBeenCalledWith(workspaceId, {
      kind: "planningDocument", documentId: "plan", documentSha256: `sha256:${"a".repeat(64)}`, line: 11,
    }, "Check the imported evidence.", "user"));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("textbox", { name: "Edit PLAN.md" })).toHaveValue(contents);
    expect(fake.updateWorkspacePlanningDocument).not.toHaveBeenCalled();
  });

  it.each(["planning_document_too_large", "invalid_planning_document"])("opens the workspace for a planning file WTS cannot read: %s", async (code) => {
    const user = userEvent.setup();
    const fake = planningClient();
    fake.readWorkspacePlanningDocument.mockRejectedValue(new WorkspaceClientError("WTS cannot read this file.", { code }));
    render(<PlanningDocumentsPanel client={fake.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />);
    await user.click(await screen.findByRole("button", { name: "Open workspace in VS Code" }));
    expect(fake.openWorkspaceInVscode).toHaveBeenCalledWith(workspaceId);
    expect(screen.getByText("Edit this file in VS Code, then refresh the planning files.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(fake.readWorkspacePlanningDocument).toHaveBeenCalledOnce();
  });

  it("refreshes an empty planning list and offers the supported planning workspace flow", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    fake.listWorkspacePlanningDocuments.mockResolvedValueOnce({ workspaceId, documents: [] });
    const onCreatePlanningHome = vi.fn();
    render(<PlanningDocumentsPanel client={fake.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" onCreatePlanningHome={onCreatePlanningHome} />);
    await user.click(await screen.findByRole("button", { name: "Create planning workspace" }));
    expect(onCreatePlanningHome).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Refresh planning files" }));
    expect(await screen.findByRole("article", { name: "PLAN.md preview" })).toBeVisible();
    expect(fake.listWorkspacePlanningDocuments).toHaveBeenCalledTimes(2);
  });

  it("refreshes the file list when the selected planning file was removed", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    fake.readWorkspacePlanningDocument.mockRejectedValueOnce(new WorkspaceClientError("The planning file was removed.", { code: "planning_document_unavailable" }));
    fake.listWorkspacePlanningDocuments.mockResolvedValueOnce({ workspaceId, documents: [{ documentId: "plan", fileName: "PLAN.md" }] }).mockResolvedValueOnce({ workspaceId, documents: [{ documentId: "readme", fileName: "README.md" }] });
    render(<PlanningDocumentsPanel client={fake.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />);
    await user.click(await screen.findByRole("button", { name: "Refresh planning files" }));
    expect(await screen.findByRole("article", { name: "README.md preview" })).toBeVisible();
    expect(fake.readWorkspacePlanningDocument).toHaveBeenLastCalledWith(workspaceId, "readme");
  });

  it("shows cached planning content while a return refresh is pending", async () => {
    const fake = planningClient();
    const panel = <PlanningDocumentsPanel client={fake.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />;
    const view = render(panel);
    expect(await screen.findByRole("article", { name: "PLAN.md preview" })).toBeVisible();
    view.unmount();
    fake.listWorkspacePlanningDocuments.mockReturnValue(new Promise(() => {}));
    fake.readWorkspacePlanningDocument.mockReturnValue(new Promise(() => {}));
    render(panel);
    expect(screen.getByRole("article", { name: "PLAN.md preview" })).toBeVisible();
    expect(screen.queryByText("Loading planning files…")).not.toBeInTheDocument();
    await waitFor(() => expect(fake.listWorkspacePlanningDocuments).toHaveBeenCalledTimes(2));
  });

  it("keeps an unfinished planning edit when a return refresh has newer contents", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    const panel = <PlanningDocumentsPanel client={fake.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />;
    const view = render(panel);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit PLAN.md" }), { target: { value: "My unfinished plan" } });
    view.unmount();
    fake.readWorkspacePlanningDocument.mockResolvedValue(planningDocument("plan", "New external contents", "b"));
    render(panel);
    expect(screen.getByRole("textbox", { name: "Edit PLAN.md" })).toHaveValue("My unfinished plan");
    await waitFor(() => expect(fake.readWorkspacePlanningDocument).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("textbox", { name: "Edit PLAN.md" })).toHaveValue("My unfinished plan");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(fake.updateWorkspacePlanningDocument).toHaveBeenCalledWith(workspaceId, "plan", `sha256:${"a".repeat(64)}`, "My unfinished plan");
  });

  it("keeps cached planning content after refresh errors and retries in place", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    const panel = <PlanningDocumentsPanel client={fake.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />;
    const view = render(panel);
    await screen.findByRole("article", { name: "PLAN.md preview" });
    view.unmount();
    fake.listWorkspacePlanningDocuments.mockRejectedValue(new Error("List unavailable"));
    fake.readWorkspacePlanningDocument.mockRejectedValueOnce(new Error("File unavailable"));
    render(panel);
    expect(screen.getByRole("article", { name: "PLAN.md preview" })).toBeVisible();
    await screen.findByRole("button", { name: "Retry file list" });
    await user.click(await screen.findByRole("button", { name: "Retry file" }));
    await waitFor(() => expect(fake.readWorkspacePlanningDocument).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("article", { name: "PLAN.md preview" })).toBeVisible();
  });

  it("isolates cached plans and drafts when the client changes", async () => {
    const user = userEvent.setup();
    const first = planningClient();
    const second = planningClient();
    second.listWorkspacePlanningDocuments.mockReturnValue(new Promise(() => {}));
    const view = render(<PlanningDocumentsPanel client={first.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit PLAN.md" }), { target: { value: "Private first-client draft" } });
    view.rerender(<PlanningDocumentsPanel client={second.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />);
    expect(screen.queryByRole("textbox", { name: "Edit PLAN.md" })).not.toBeInTheDocument();
    expect(screen.queryByText("Private first-client draft")).not.toBeInTheDocument();
    view.rerender(<PlanningDocumentsPanel client={first.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />);
    expect(screen.getByRole("textbox", { name: "Edit PLAN.md" })).toHaveValue("Private first-client draft");
  });

  it("retains an unfinished edit when the refreshed list no longer contains its file", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    const panel = <PlanningDocumentsPanel client={fake.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />;
    const first = render(panel);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit PLAN.md" }), { target: { value: "Retain this draft" } });
    first.unmount();
    fake.listWorkspacePlanningDocuments.mockResolvedValue({ workspaceId, documents: [] });
    fake.readWorkspacePlanningDocument.mockRejectedValue(new Error("File removed"));
    render(panel);
    await screen.findByRole("button", { name: "Retry file" });
    expect(screen.getByRole("textbox", { name: "Edit PLAN.md" })).toHaveValue("Retain this draft");
  });

  it("keeps an unfinished feedback draft anchored to its original document revision", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    const panel = <PlanningDocumentsPanel client={fake.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />;
    const first = render(panel);
    await user.click(await screen.findByRole("button", { name: "Source" }));
    await user.click(screen.getByRole("button", { name: "Line 3: - [ ] Confirm the retry rule." }));
    fireEvent.change(screen.getByRole("textbox", { name: "Feedback for PLAN.md" }), { target: { value: "Check this original line" } });
    first.unmount();
    fake.readWorkspacePlanningDocument.mockResolvedValue(planningDocument("plan", "# External revision", "b"));
    render(panel);
    await waitFor(() => expect(fake.readWorkspacePlanningDocument).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Add feedback" }));
    expect(fake.createWorkspaceReviewThread).toHaveBeenCalledWith(workspaceId, {
      kind: "planningDocument", documentId: "plan", documentSha256: `sha256:${"a".repeat(64)}`, line: 3,
    }, "Check this original line", "user");
  });

  it("retains an unfinished draft after more than 24 other workspaces are visited", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    fake.listWorkspacePlanningDocuments.mockImplementation(async (id: string) => ({ workspaceId: id, documents: [{ documentId: "plan", fileName: "PLAN.md" }] }));
    fake.readWorkspacePlanningDocument.mockImplementation(async (id: string) => ({ ...planningDocument("plan", `# ${id}`), workspaceId: id }));
    fake.listWorkspaceReviewThreads.mockImplementation(async (id: string) => ({ workspaceId: id, threads: [] }));
    const panel = (id: string) => <PlanningDocumentsPanel client={fake.client} workspaceId={id} workspaceKey={id} />;
    const view = render(panel(workspaceId));
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit PLAN.md" }), { target: { value: "Keep this unfinished plan" } });
    for (let index = 0; index < 25; index += 1) {
      const id = `visited-${index}`;
      view.rerender(panel(id));
      await screen.findByRole("heading", { name: id });
    }
    view.rerender(panel(workspaceId));
    expect(await screen.findByRole("textbox", { name: "Edit PLAN.md" })).toHaveValue("Keep this unfinished plan");
  });

  it("requires space for a new draft and retains the existing 24 drafts", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    for (let index = 0; index < 24; index += 1) {
      rememberPlanningView(fake.client, `draft-${index}`, {
        selectedId: "plan", document: planningDocument("plan", "Original"), documentView: "source",
        editing: true, draft: `Draft ${index}`, query: "", filter: "current", feedbackDraft: "", selectedLine: null,
      });
    }
    render(<PlanningDocumentsPanel client={fake.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("textbox", { name: "Edit PLAN.md" })).not.toBeInTheDocument();
    expect(screen.getByText(/WTS has 24 unfinished planning drafts/)).toBeVisible();
    expect(planningViewFor(fake.client, "draft-0")?.draft).toBe("Draft 0");
    const previous = planningViewFor(fake.client, "draft-0")!;
    rememberPlanningView(fake.client, "draft-0", { ...previous, editing: false, draft: previous.document!.contents });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("textbox", { name: "Edit PLAN.md" })).toBeVisible();
    expect(planningViewFor(fake.client, "draft-23")?.draft).toBe("Draft 23");
  });

  it("clears a feedback draft when its write succeeds after the pane closes", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    const pending = deferred<WorkspaceReviewThread>();
    fake.createWorkspaceReviewThread.mockReturnValue(pending.promise);
    const panel = <PlanningDocumentsPanel client={fake.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />;
    const first = render(panel);
    await user.click(await screen.findByRole("button", { name: "Source" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Feedback for PLAN.md" }), { target: { value: "Publish this once" } });
    await user.click(screen.getByRole("button", { name: "Add feedback" }));
    first.unmount();
    await act(async () => { pending.resolve(reviewThread({ threadId: "new-thread", body: "Publish this once" })); });
    render(panel);
    expect(screen.getByRole("textbox", { name: "Feedback for PLAN.md" })).toHaveValue("");
    expect(fake.createWorkspaceReviewThread).toHaveBeenCalledTimes(1);
  });

  it("keeps late planning responses scoped to their workspace", async () => {
    const fake = planningClient();
    const late = deferred<WorkspacePlanningDocument>();
    fake.listWorkspacePlanningDocuments.mockImplementation(async (id: string) => ({ workspaceId: id, documents: [{ documentId: "plan", fileName: "PLAN.md" }] }));
    fake.readWorkspacePlanningDocument.mockImplementation((id: string) => id === workspaceId ? late.promise : Promise.resolve({ ...planningDocument("plan", "# Other workspace"), workspaceId: id }));
    fake.listWorkspaceReviewThreads.mockImplementation(async (id: string) => ({ workspaceId: id, threads: [] }));
    const view = render(<PlanningDocumentsPanel client={fake.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />);
    await waitFor(() => expect(fake.readWorkspacePlanningDocument).toHaveBeenCalledTimes(1));
    view.rerender(<PlanningDocumentsPanel client={fake.client} workspaceId="other-workspace" workspaceKey="PLATFORM-99" />);
    await screen.findByRole("heading", { name: "Other workspace" });
    await act(async () => { late.resolve(planningDocument("plan", "# First workspace")); });
    expect(screen.getByRole("heading", { name: "Other workspace" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "First workspace" })).not.toBeInTheDocument();
    view.rerender(<PlanningDocumentsPanel client={fake.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />);
    expect(screen.getByRole("heading", { name: "First workspace" })).toBeVisible();
  });

  it("keeps a successful save when an older background read finishes later", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    const panel = <PlanningDocumentsPanel client={fake.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />;
    const first = render(panel);
    await screen.findByRole("article", { name: "PLAN.md preview" });
    first.unmount();
    const refresh = deferred<WorkspacePlanningDocument>();
    fake.readWorkspacePlanningDocument.mockReturnValueOnce(refresh.promise);
    fake.updateWorkspacePlanningDocument.mockResolvedValue(planningDocument("plan", "# Saved plan", "b"));
    const second = render(panel);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit PLAN.md" }), { target: { value: "# Saved plan" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { name: "Saved plan" });
    await act(async () => { refresh.resolve(planningDocument("plan", "# Old plan")); });
    expect(screen.getByRole("heading", { name: "Saved plan" })).toBeVisible();
    second.unmount();
    fake.readWorkspacePlanningDocument.mockReturnValue(new Promise(() => {}));
    render(panel);
    expect(screen.getByRole("heading", { name: "Saved plan" })).toBeVisible();
  });

  it("renders Markdown by default and keeps the complete source available", async () => {
    const user = userEvent.setup();
    const fake = planningClient();

    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    const files = await screen.findByRole("navigation", {
      name: "Planning files",
    });
    expect(files.closest('[data-ui="planning.files"]')).toHaveAttribute(
      "data-ui-label",
      "Planning file explorer",
    );
    const buttons = within(files).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      expect.stringContaining("PLAN.md"),
      expect.stringContaining("KANBAN.md"),
      expect.stringContaining("FINDINGS.md"),
      expect.stringContaining("README.md"),
    ]);
    expect(document.body).not.toHaveTextContent("/private/workspace");

    const preview = await screen.findByRole("article", {
      name: "PLAN.md preview",
    });
    expect(within(preview).getByRole("heading", { name: "Plan" })).toBeVisible();
    expect(within(preview).getByRole("checkbox")).not.toBeChecked();
    expect(within(preview).getByText("User decision")).toBeVisible();
    expect(preview).not.toHaveTextContent("# Plan");
    expect(screen.getByRole("button", { name: "Preview" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Source" }));
    const source = screen.getByRole("region", { name: "PLAN.md contents" });
    expect(source).toHaveTextContent("# Plan");
    expect(source).toHaveTextContent("- [ ] Confirm the retry rule.");
    expect(source).toHaveTextContent("> User decision");
    expect(mermaidMocks.render).not.toHaveBeenCalled();
    expect(fake.readWorkspacePlanningDocument).toHaveBeenCalledWith(
      workspaceId,
      "plan",
    );
    expect(screen.getByText("Read only")).toBeVisible();
  });

  it("lists generated files and opens CSV evidence by its opaque identifier", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    const generatedId = `generated-${"b".repeat(64)}` as WorkspacePlanningDocument["documentId"];
    fake.listWorkspacePlanningDocuments.mockResolvedValue({
      workspaceId,
      documents: [
        { documentId: "plan", fileName: "PLAN.md" },
        {
          documentId: generatedId,
          fileName: "mh1-bmc-credential-check-failures-2026-08-31.csv",
        },
      ],
    });
    fake.readWorkspacePlanningDocument.mockImplementation(
      async (_workspaceId, documentId) =>
        documentId === generatedId
          ? {
              workspaceId,
              documentId,
              fileName: "mh1-bmc-credential-check-failures-2026-08-31.csv",
              contents: "host,status\nnode-1,failed\n",
              sha256: `sha256:${"b".repeat(64)}`,
            }
          : planningDocument(documentId, "# Plan\n"),
    );

    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    const generatedFile = await screen.findByRole("button", {
      name: /mh1-bmc-credential-check-failures-2026-08-31\.csv/i,
    });
    expect(generatedFile).toHaveAttribute(
      "aria-description",
      "Generated evidence data",
    );
    await user.click(generatedFile);

    const preview = await screen.findByRole("article", {
      name: "mh1-bmc-credential-check-failures-2026-08-31.csv preview",
    });
    expect(preview).toHaveTextContent("host,status");
    expect(preview).toHaveTextContent("node-1,failed");
    expect(fake.readWorkspacePlanningDocument).toHaveBeenLastCalledWith(
      workspaceId,
      generatedId,
    );
  });

  it("filters the compact file list and keeps old file tags for the workspace", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    const view = render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    const files = await screen.findByRole("navigation", {
      name: "Planning files",
    });
    await user.type(screen.getByRole("searchbox", { name: "Search planning files" }), "kan");
    expect(within(files).getByRole("button", { name: "KANBAN.md" })).toBeVisible();
    expect(within(files).queryByRole("button", { name: "PLAN.md" })).toBeNull();

    await user.clear(screen.getByRole("searchbox", { name: "Search planning files" }));
    await user.click(within(files).getByRole("button", { name: "KANBAN.md" }));
    await screen.findByRole("article", { name: "KANBAN.md preview" });
    await user.click(screen.getByRole("button", { name: "Mark KANBAN.md as old" }));

    expect(within(files).queryByRole("button", { name: "KANBAN.md" })).toBeNull();
    expect(JSON.parse(localStorage.getItem("wts.planning-file-states.v1") ?? "{}"))
      .toEqual({ [workspaceId]: ["kanban"] });

    view.unmount();
    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );
    const restoredFiles = await screen.findByRole("navigation", {
      name: "Planning files",
    });
    expect(within(restoredFiles).queryByRole("button", { name: "KANBAN.md" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Old" }));
    expect(within(restoredFiles).getByRole("button", { name: /KANBAN\.md/i })).toHaveTextContent("Old");
  });

  it("selects multiple visible files and marks them old as one action", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    const onNotice = vi.fn();
    render(
      <PlanningDocumentsPanel
        client={fake.client}
        onNotice={onNotice}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    const files = await screen.findByRole("navigation", {
      name: "Planning files",
    });
    await screen.findByRole("article", { name: "PLAN.md preview" });
    await user.click(
      within(files).getByRole("checkbox", { name: "Select PLAN.md" }),
    );
    await user.click(
      within(files).getByRole("checkbox", { name: "Select KANBAN.md" }),
    );

    expect(
      screen.getByRole("checkbox", {
        name: "Select all visible planning files",
      }),
    ).toHaveAttribute("aria-checked", "mixed");
    const actions = screen.getByRole("toolbar", {
      name: "Planning file selection actions",
    });
    expect(actions).toHaveAttribute(
      "data-ui",
      "planning.file-selection-actions",
    );
    expect(
      actions.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(actions).getByText("2 selected")).toBeVisible();
    await user.click(within(actions).getByRole("button", { name: "Mark old" }));

    expect(within(files).queryByRole("button", { name: "PLAN.md" })).toBeNull();
    expect(within(files).queryByRole("button", { name: "KANBAN.md" })).toBeNull();
    expect(
      JSON.parse(localStorage.getItem("wts.planning-file-states.v1") ?? "{}"),
    ).toEqual({ [workspaceId]: ["plan", "kanban"] });
    expect(onNotice).toHaveBeenCalledWith("2 planning files marked old");

    await user.click(screen.getByRole("button", { name: "Old" }));
    await user.click(
      screen.getByRole("checkbox", {
        name: "Select all visible planning files",
      }),
    );
    expect(
      screen.getByRole("checkbox", {
        name: "Select all visible planning files",
      }),
    ).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Mark current" }));
    expect(onNotice).toHaveBeenLastCalledWith(
      "2 planning files marked current",
    );
  });

  it("shows both available actions for a mixed planning file selection", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    localStorage.setItem(
      "wts.planning-file-states.v1",
      JSON.stringify({ [workspaceId]: ["kanban"] }),
    );
    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await screen.findByRole("article", { name: "PLAN.md preview" });
    await user.click(screen.getByRole("button", { name: "All" }));
    await user.click(screen.getByRole("checkbox", { name: "Select PLAN.md" }));
    await user.click(
      screen.getByRole("checkbox", { name: "Select KANBAN.md" }),
    );

    const actions = screen.getByRole("toolbar", {
      name: "Planning file selection actions",
    });
    expect(within(actions).getByRole("button", { name: "Mark old" })).toBeVisible();
    expect(
      within(actions).getByRole("button", { name: "Mark current" }),
    ).toBeVisible();
  });

  it("uses arrow, Home, and End keys to select an exact file", async () => {
    const fake = planningClient();
    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    const files = await screen.findByRole("navigation", {
      name: "Planning files",
    });
    const plan = within(files).getByRole("button", { name: /PLAN\.md/i });
    plan.focus();
    fireEvent.keyDown(plan, { key: "ArrowDown" });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const kanban = within(files).getByRole("button", { name: /KANBAN\.md/i });
    expect(kanban).toHaveFocus();
    expect(kanban).toHaveAttribute("aria-current", "page");
    await screen.findByRole("article", { name: "KANBAN.md preview" });

    fireEvent.keyDown(kanban, { key: "End" });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const readme = within(files).getByRole("button", { name: /README\.md/i });
    expect(readme).toHaveFocus();
    expect(readme).toHaveAttribute("aria-current", "page");

    fireEvent.keyDown(readme, { key: "Home" });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(plan).toHaveFocus();
    expect(plan).toHaveAttribute("aria-current", "page");
  });

  it("uses ArrowRight and ArrowLeft to select the exact file in the horizontal rail", async () => {
    const fake = planningClient();
    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    const files = await screen.findByRole("navigation", {
      name: "Planning files",
    });
    const plan = within(files).getByRole("button", { name: /PLAN\.md/i });
    const kanban = within(files).getByRole("button", { name: /KANBAN\.md/i });
    plan.focus();

    fireEvent.keyDown(plan, { key: "ArrowRight" });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(kanban).toHaveFocus();
    expect(kanban).toHaveAttribute("aria-current", "page");
    await screen.findByRole("article", { name: "KANBAN.md preview" });
    expect(fake.readWorkspacePlanningDocument).toHaveBeenLastCalledWith(
      workspaceId,
      "kanban",
    );

    fireEvent.keyDown(kanban, { key: "ArrowLeft" });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(plan).toHaveFocus();
    expect(plan).toHaveAttribute("aria-current", "page");
    await screen.findByRole("article", { name: "PLAN.md preview" });
    expect(fake.readWorkspacePlanningDocument).toHaveBeenLastCalledWith(
      workspaceId,
      "plan",
    );
  });

  it.each(["stay", "leave", "return before acknowledgement"])("keeps text entered during Save and advances its digest (%s)", async (navigation) => {
    const fake = planningClient();
    const pending = deferred<WorkspacePlanningDocument>();
    fake.updateWorkspacePlanningDocument.mockReturnValueOnce(pending.promise);
    const panel = <PlanningDocumentsPanel client={fake.client} workspaceId={workspaceId} workspaceKey="PLATFORM-42" />;
    const view = render(panel);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit PLAN.md" }), { target: { value: "# First saved revision" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fake.updateWorkspacePlanningDocument).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit PLAN.md" }), { target: { value: "# First saved revision\nKeep the newer text." } });
    if (navigation !== "stay") view.unmount();
    if (navigation === "return before acknowledgement") {
      render(panel);
      expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
      expect(fake.updateWorkspacePlanningDocument).toHaveBeenCalledTimes(1);
    }
    await act(async () => { pending.resolve(planningDocument("plan", "# First saved revision", "b")); });
    if (navigation === "leave") render(panel);
    expect(screen.getByRole("textbox", { name: "Edit PLAN.md" })).toHaveValue("# First saved revision\nKeep the newer text.");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fake.updateWorkspacePlanningDocument).toHaveBeenLastCalledWith(workspaceId, "plan", `sha256:${"b".repeat(64)}`, "# First saved revision\nKeep the newer text.");
  });

  it("saves an edited file with the digest that the user opened", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    fake.updateWorkspacePlanningDocument.mockResolvedValue(
      planningDocument("plan", "# Revised plan", "b"),
    );
    const onNotice = vi.fn();

    render(
      <PlanningDocumentsPanel
        client={fake.client}
        onNotice={onNotice}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Edit PLAN.md" });
    expect(screen.getByText("Editing")).toBeVisible();
    await user.clear(editor);
    await user.type(editor, "# Revised plan");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fake.updateWorkspacePlanningDocument).toHaveBeenCalledWith(
        workspaceId,
        "plan",
        `sha256:${"a".repeat(64)}`,
        "# Revised plan",
      ),
    );
    expect(
      await screen.findByRole("article", { name: "PLAN.md preview" }),
    ).toHaveTextContent("Revised plan");
    expect(screen.getByText("Read only")).toBeVisible();
    expect(onNotice).toHaveBeenCalledWith("PLAN.md saved");
    await waitFor(() =>
      expect(fake.listWorkspaceReviewThreads).toHaveBeenCalledTimes(2),
    );
  });

  it("keeps the draft and requires a reload after a revision conflict", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    fake.readWorkspacePlanningDocument
      .mockReset()
      .mockResolvedValueOnce(planningDocument("plan", "# First plan"))
      .mockResolvedValueOnce(planningDocument("plan", "# Latest plan", "c"));
    fake.updateWorkspacePlanningDocument.mockRejectedValue(
      new WorkspaceClientError("The planning document changed", {
        code: "planning_document_conflict",
        status: 409,
      }),
    );

    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Edit PLAN.md" });
    await user.clear(editor);
    await user.type(editor, "# My edit");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const conflict = await screen.findByRole("alert");
    expect(within(conflict).getByText("Newer file available")).toBeVisible();
    expect(editor).toHaveValue("# My edit");
    await user.click(
      within(conflict).getByRole("button", { name: "Reload latest" }),
    );

    const preview = await screen.findByRole("article", {
      name: "PLAN.md preview",
    });
    expect(preview).toHaveTextContent("Latest plan");
    expect(fake.readWorkspacePlanningDocument).toHaveBeenCalledTimes(2);
  });

  it("retries a failed save without losing the user's draft", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    fake.updateWorkspacePlanningDocument
      .mockRejectedValueOnce(new Error("The local file is busy"))
      .mockResolvedValueOnce(planningDocument("plan", "# Retry draft", "d"));

    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Edit PLAN.md" });
    await user.clear(editor);
    await user.type(editor, "# Retry draft");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const failure = await screen.findByRole("alert");
    expect(within(failure).getByText("The local file is busy")).toBeVisible();
    expect(editor).toHaveValue("# Retry draft");
    await user.click(
      within(failure).getByRole("button", { name: "Try save again" }),
    );

    expect(
      await screen.findByRole("article", { name: "PLAN.md preview" }),
    ).toHaveTextContent("Retry draft");
    expect(fake.updateWorkspacePlanningDocument).toHaveBeenCalledTimes(2);
  });

  it("offers a deterministic retry when the planning list fails", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    fake.listWorkspacePlanningDocuments
      .mockReset()
      .mockRejectedValueOnce(new Error("Planning store is busy"))
      .mockResolvedValueOnce({
        workspaceId,
        documents: [{ documentId: "plan", fileName: "PLAN.md" }],
      });

    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Planning store is busy",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("article", { name: "PLAN.md preview" }),
    ).toBeVisible();
    expect(fake.listWorkspacePlanningDocuments).toHaveBeenCalledTimes(2);
  });

  it("offers to create a planning home when the workspace has none", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    const onCreatePlanningHome = vi.fn();
    fake.listWorkspacePlanningDocuments.mockReset().mockRejectedValue(
      new WorkspaceClientError("This workspace does not have a planning home.", {
        code: "planning_not_configured",
      }),
    );

    render(
      <PlanningDocumentsPanel
        client={fake.client}
        onCreatePlanningHome={onCreatePlanningHome}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This workspace does not have a planning home.",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Create planning home" }),
    );
    expect(onCreatePlanningHome).toHaveBeenCalledOnce();
  });

  it("adds feedback to a selected line without changing the file", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    const created = reviewThread({
      threadId: "thread-line",
      body: "Confirm this retry rule with the service owner.",
    });
    fake.createWorkspaceReviewThread.mockResolvedValue(created);

    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Source" }));
    await user.click(
      await screen.findByRole("button", {
        name: "Line 3: - [ ] Confirm the retry rule.",
      }),
    );
    const feedback = screen.getByRole("textbox", {
      name: "Feedback for PLAN.md",
    });
    await user.type(
      feedback,
      "Confirm this retry rule with the service owner.",
    );
    await user.click(screen.getByRole("button", { name: "Add feedback" }));

    await waitFor(() =>
      expect(fake.createWorkspaceReviewThread).toHaveBeenCalledWith(
        workspaceId,
        {
          kind: "planningDocument",
          documentId: "plan",
          documentSha256: `sha256:${"a".repeat(64)}`,
          line: 3,
        },
        "Confirm this retry rule with the service owner.",
        "user",
      ),
    );
    expect(
      await screen.findByLabelText("Open feedback on line 3"),
    ).toHaveTextContent("Confirm this retry rule with the service owner.");
    expect(feedback).toHaveValue("");
    expect(fake.updateWorkspacePlanningDocument).not.toHaveBeenCalled();
    expect(
      screen.getByRole("region", { name: "PLAN.md contents" }),
    ).toHaveTextContent("- [ ] Confirm the retry rule.");
  });

  it("adds file feedback when the user does not select a line", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    fake.createWorkspaceReviewThread.mockResolvedValue(
      reviewThread({
        threadId: "thread-file",
        body: "Add the rollback decision.",
        target: {
          kind: "planningDocument",
          documentId: "plan",
          documentSha256: `sha256:${"a".repeat(64)}`,
        },
      }),
    );

    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    const feedback = await screen.findByRole("textbox", {
      name: "Feedback for PLAN.md",
    });
    await screen.findByText("No open feedback.");
    await user.type(feedback, "Add the rollback decision.");
    await user.click(screen.getByRole("button", { name: "Add feedback" }));

    await waitFor(() =>
      expect(fake.createWorkspaceReviewThread).toHaveBeenCalledWith(
        workspaceId,
        {
          kind: "planningDocument",
          documentId: "plan",
          documentSha256: `sha256:${"a".repeat(64)}`,
        },
        "Add the rollback decision.",
        "user",
      ),
    );
  });

  it("shows open and resolved feedback, marks stale source, and resolves with the revision", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    const open = reviewThread({
      threadId: "thread-open",
      body: "Is this still the selected approach?",
      anchorState: "stale",
    });
    const resolved = reviewThread({
      threadId: "thread-resolved",
      body: "The user approved this decision.",
      state: "resolved",
      revision: 2,
      resolvedAtUnixMs: 1_720_000_000_200,
    });
    fake.listWorkspaceReviewThreads.mockResolvedValue({
      workspaceId,
      threads: [resolved, open],
    });
    fake.resolveWorkspaceReviewThread.mockResolvedValue({
      ...open,
      state: "resolved",
      revision: 5,
      resolvedAtUnixMs: 1_720_000_000_300,
    });

    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    const openCard = await screen.findByLabelText("Open feedback on line 3");
    expect(within(openCard).getByText("Stale source")).toBeVisible();
    expect(
      screen.getByLabelText("Resolved feedback on line 3"),
    ).toHaveTextContent("The user approved this decision.");
    await user.click(within(openCard).getByRole("button", { name: "Resolve" }));

    await waitFor(() =>
      expect(fake.resolveWorkspaceReviewThread).toHaveBeenCalledWith(
        workspaceId,
        "thread-open",
        4,
      ),
    );
    expect(
      screen.getAllByLabelText("Resolved feedback on line 3"),
    ).toHaveLength(2);
  });

  it("uses arrow keys to select feedback lines and Escape to select the whole file", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Source" }));
    const firstLine = await screen.findByRole("button", {
      name: "Line 1: # Plan",
    });
    firstLine.focus();
    fireEvent.keyDown(firstLine, { key: "End" });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const lastLine = screen.getByRole("button", {
      name: "Line 5: > User decision",
    });
    expect(lastLine).toHaveFocus();
    expect(lastLine).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Line 5")).toBeVisible();

    fireEvent.keyDown(lastLine, { key: "Escape" });
    expect(lastLine).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Whole file")).toBeVisible();
  });

  it("caches workspace feedback while the user switches between planning files", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    const workspaceRequest = deferred<{
      workspaceId: string;
      threads: WorkspaceReviewThread[];
    }>();
    fake.listWorkspaceReviewThreads
      .mockReset()
      .mockReturnValueOnce(workspaceRequest.promise);

    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await screen.findByRole("article", { name: "PLAN.md preview" });
    await user.click(screen.getByRole("button", { name: /KANBAN\.md/i }));
    await screen.findByRole("article", { name: "KANBAN.md preview" });
    expect(fake.listWorkspaceReviewThreads).toHaveBeenCalledTimes(1);

    const current = reviewThread({
      threadId: "thread-current",
      body: "Current Kanban feedback",
      target: {
        kind: "planningDocument",
        documentId: "kanban",
        documentSha256: `sha256:${"a".repeat(64)}`,
        line: 1,
      },
    });
    await act(async () => {
      workspaceRequest.resolve({ workspaceId, threads: [current] });
    });
    expect(await screen.findByText("Current Kanban feedback")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /FINDINGS\.md/i }));
    await screen.findByRole("article", { name: "FINDINGS.md preview" });
    expect(fake.listWorkspaceReviewThreads).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Current Kanban feedback")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /KANBAN\.md/i }));
    await screen.findByRole("article", { name: "KANBAN.md preview" });
    expect(screen.getByText("Current Kanban feedback")).toBeVisible();
    expect(fake.listWorkspaceReviewThreads).toHaveBeenCalledTimes(1);
  });

  it("renders GFM and blocks active or remote Markdown content", async () => {
    const fake = planningClient();
    fake.readWorkspacePlanningDocument.mockResolvedValue(
      planningDocument(
        "plan",
        [
          "# Delivery",
          "",
          "| Item | State |",
          "| --- | --- |",
          "| API | Ready |",
          "",
          "~~Old plan~~",
          "",
          "[Docs](https://example.com/docs)",
          "[Unsafe](javascript:alert(1))",
          "![Remote plan](https://example.com/plan.png)",
          '<img src="x" onerror="alert(1)">',
        ].join("\n"),
      ),
    );

    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    const preview = await screen.findByRole("article", {
      name: "PLAN.md preview",
    });
    expect(within(preview).getByRole("table")).toHaveTextContent("APIReady");
    expect(within(preview).getByText("Old plan").tagName).toBe("DEL");
    expect(within(preview).getByRole("link", { name: "Docs" })).toHaveAttribute(
      "href",
      "https://example.com/docs",
    );
    expect(within(preview).queryByRole("link", { name: "Unsafe" })).toBeNull();
    expect(within(preview).getByText("Unsafe")).toBeVisible();
    expect(
      within(preview).getByRole("note", { name: "" }),
    ).toHaveTextContent("Image not loaded: Remote plan");
    expect(within(preview).queryByRole("img")).toBeNull();
    expect(preview).not.toHaveTextContent("onerror");
  });

  it("renders a Mermaid fence as sanitized inline SVG", async () => {
    const fake = planningClient();
    mermaidMocks.render.mockResolvedValueOnce({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><a href="https://example.com"><text>Rendered</text></a></svg>',
    });
    fake.readWorkspacePlanningDocument.mockResolvedValue(
      planningDocument(
        "plan",
        "# Flow\n\n```mermaid\nflowchart LR\n  Start --> Done\n```",
      ),
    );

    const view = render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    const image = await screen.findByRole("img", { name: "Mermaid diagram" });
    const svg = image.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).not.toHaveAttribute("onload");
    expect(svg?.querySelector("script")).toBeNull();
    expect(svg?.querySelector("a")).not.toHaveAttribute("href");
    expect(image).toHaveTextContent("Rendered");
    expect(mermaidMocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: "strict",
        startOnLoad: false,
      }),
    );
    expect(mermaidMocks.render).toHaveBeenCalledWith(
      expect.stringMatching(/^planning-mermaid-/),
      "flowchart LR\n  Start --> Done",
    );
    view.unmount();
  });

  it("keeps a rendered diagram and its zoom during planning screen updates", async () => {
    const user = userEvent.setup();
    const fake = planningClient();
    fake.readWorkspacePlanningDocument.mockResolvedValue(
      planningDocument(
        "plan",
        "# Flow\n\n```mermaid\nflowchart LR\n  Start --> Done\n```",
      ),
    );
    const panel = (
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />
    );
    const view = render(panel);

    const image = await screen.findByRole("img", { name: "Mermaid diagram" });
    const imageMarkup = image.innerHTML;
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByLabelText("Diagram zoom")).toHaveTextContent("156%");
    expect(image.style.transform).toContain("scale(1.5625)");

    view.rerender(panel);
    await user.type(
      screen.getByRole("searchbox", { name: "Search planning files" }),
      "plan",
    );

    await waitFor(() => expect(mermaidMocks.render).toHaveBeenCalledOnce());
    expect(fake.listWorkspacePlanningDocuments).toHaveBeenCalledOnce();
    expect(fake.readWorkspacePlanningDocument).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Diagram zoom")).toHaveTextContent("156%");
    expect(image.style.transform).toContain("scale(1.5625)");
    expect(image.innerHTML).toBe(imageMarkup);

    await user.click(
      screen.getByRole("button", { name: "Reset diagram zoom" }),
    );
    expect(screen.getByLabelText("Diagram zoom")).toHaveTextContent("100%");
    expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");
  });

  it("zooms a Mermaid diagram with a trackpad pinch gesture", async () => {
    const fake = planningClient();
    const diagramRender = deferred<{ svg: string }>();
    mermaidMocks.render.mockReturnValueOnce(diagramRender.promise);
    fake.readWorkspacePlanningDocument.mockResolvedValue(
      planningDocument(
        "plan",
        "# Flow\n\n```mermaid\nflowchart LR\n  Start --> Done\n```",
      ),
    );

    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await waitFor(() => expect(mermaidMocks.render).toHaveBeenCalledOnce());
    await act(async () => {
      diagramRender.resolve({
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Rendered</text></svg>',
      });
      await diagramRender.promise;
    });
    const image = await screen.findByRole("img", { name: "Mermaid diagram" });
    const canvas = screen.getByRole("region", {
      name: "Mermaid diagram canvas",
    });
    expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");

    fireEvent.wheel(canvas, { ctrlKey: false, deltaX: 5_000, deltaY: -3_000 });
    expect(screen.getByLabelText("Diagram zoom")).toHaveTextContent("100%");
    expect(image.style.transform).toBe(
      "translate(-5000px, 3000px) scale(1)",
    );

    fireEvent.wheel(canvas, { ctrlKey: true, deltaY: -25 });
    const wheelZoom = Number.parseInt(
      screen.getByLabelText("Diagram zoom").textContent ?? "0",
      10,
    );
    expect(wheelZoom).toBeGreaterThan(100);
    expect(image.style.transform).toMatch(/scale\(1\.[0-9]+\)$/);

    fireEvent(canvas, new Event("gesturestart", { cancelable: true }));
    const gestureChange = new Event("gesturechange", { cancelable: true });
    Object.defineProperty(gestureChange, "scale", { value: 2 });
    fireEvent(canvas, gestureChange);
    const gestureZoom = Number.parseInt(
      screen.getByLabelText("Diagram zoom").textContent ?? "0",
      10,
    );
    expect(gestureZoom).toBeGreaterThan(wheelZoom * 1.9);
  });

  it("renders a Mermaid architecture diagram with encoded indentation", async () => {
    const fake = planningClient();
    mermaidMocks.render
      .mockRejectedValueOnce(new Error("Invalid encoded architecture diagram"))
      .mockResolvedValueOnce({
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Rendered</text></svg>',
      });
    const encodedDiagram = [
      "flowchart LR",
      '   Operator["Operator or API client"] -->|"direct FixRoutine"| Policy',
      "",
      '   subgraph SenzuBox["Senzu — explicit opt-in"]',
      '       Policy{"firmwareAction"}',
      '       Existing["Existing audit or upgradeIfSafe flow"]',
      '       Boot["bootInstaller coordinator"]',
      '       Policy -->|"audit / upgradeIfSafe"| Existing',
      '       Policy -->|"bootInstaller"| Boot',
      "   end",
      "",
      '   Boot -->|"1. Verify live BMC identity"| Jellyfish',
      '   Boot -->|"2. POST /api/v1/installer/boot"| Arm',
      '   Boot -->|"3. One-time PXE boot"| Jellyfish',
      "",
      '   subgraph NimbusBox["Nimbus API — default off"]',
      '       Gate{"enableBootProfiles"}',
      '       Arm["Arm boot-profile endpoint"]',
      '       Intent[("BootProfileIntent\\nauxiliary table")]',
      '       Chain["Existing /api/v1/chain endpoint"]',
      '       Legacy[("GeneratedInstallerData\\nlegacy table")]',
      "",
      '       Gate -->|"true"| Arm',
      "       Arm --> Intent",
      '       Intent -->|"pending override"| Chain',
      '       Legacy -->|"unchanged fallback"| Chain',
      "   end",
      "",
      '   Jellyfish["Jellyfish / Redfish"] --> Machine["Spare server"]',
      '   Machine -->|"PXE chain request"| Chain',
      '   Chain -->|"one request only"| SmartBoot["Vendor Smart Boot iPXE"]',
      '   Chain -->|"no pending auxiliary intent"| LegacyBoot["Existing OS installer or PIOUS"]',
    ].join("\n");
    const encodedIndentation = encodedDiagram.replace(/^ +/gm, (spaces) =>
      "&#x20;".repeat(spaces.length),
    );
    fake.readWorkspacePlanningDocument.mockResolvedValue(
      planningDocument(
        "plan",
        `## Architecture and isolation boundary\n\n\`\`\`mermaid\n${encodedIndentation}\n\`\`\``,
      ),
    );

    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    expect(
      await screen.findByRole("img", { name: "Mermaid diagram" }),
    ).toBeVisible();
    expect(mermaidMocks.render).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^planning-mermaid-/),
      encodedDiagram,
    );
    expect(mermaidMocks.render).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/-compatible$/),
      encodedDiagram.replace(/\|"([^"\r\n]*)"\|/g, "|$1|"),
    );
  });

  it("renders a standalone Mermaid planning file", async () => {
    const fake = planningClient();
    fake.readWorkspacePlanningDocument.mockResolvedValue({
      ...planningDocument("plan", "kanban\n  todo[Todo]\n  done[Done]"),
      fileName: "/private/workspace/plans/board.mmd",
    });

    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    expect(
      await screen.findByRole("img", { name: "Mermaid diagram" }),
    ).toBeVisible();
    expect(mermaidMocks.render).toHaveBeenCalledWith(
      expect.stringMatching(/^planning-mermaid-/),
      "kanban\n  todo[Todo]\n  done[Done]",
    );
  });

  it("retries quoted flowchart edge labels with compatible Mermaid syntax", async () => {
    const fake = planningClient();
    mermaidMocks.render
      .mockRejectedValueOnce(new Error("Invalid edge label"))
      .mockResolvedValueOnce({
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Rendered</text></svg>',
      });
    fake.readWorkspacePlanningDocument.mockResolvedValue(
      planningDocument(
        "plan",
        '```mermaid\nflowchart LR\n  Operator -->|"direct FixRoutine"| Policy\n```',
      ),
    );

    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    expect(
      await screen.findByRole("img", { name: "Mermaid diagram" }),
    ).toBeVisible();
    expect(mermaidMocks.render).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/-compatible$/),
      "flowchart LR\n  Operator -->|direct FixRoutine| Policy",
    );
  });

  it("shows the Mermaid source when the renderer fails", async () => {
    const fake = planningClient();
    mermaidMocks.render.mockRejectedValue(new Error("Invalid diagram"));
    fake.readWorkspacePlanningDocument.mockResolvedValue(
      planningDocument("plan", "```mermaid\nnot a diagram\n```"),
    );

    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    expect(
      await screen.findByText("WTS could not render this diagram."),
    ).toBeVisible();
    expect(screen.getByText("not a diagram")).toBeVisible();
  });

  it("does not load an oversized Mermaid diagram", async () => {
    const fake = planningClient();
    const source = `flowchart LR\n${"A --> B\n".repeat(6_251)}`;
    fake.readWorkspacePlanningDocument.mockResolvedValue(
      planningDocument("plan", `\`\`\`mermaid\n${source}\`\`\``),
    );

    render(
      <PlanningDocumentsPanel
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    expect(
      await screen.findByText("This diagram is too large to render."),
    ).toBeVisible();
    expect(mermaidMocks.render).not.toHaveBeenCalled();
  });
});
