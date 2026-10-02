import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspacePlanningDocument, WorkspacePlanningDocumentId } from "../../lib/wtsClient";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import { PlanningDocumentsPanel } from "./PlanningDocumentsPanel";

const workspaceId = "nested-planning-workspace";
const documents: WorkspacePlanningDocument[] = [
  { documentId: "plan", fileName: "PLAN.md", contents: "# Root plan\n\n[Retry plan](plans/retries/PLAN.md)\n\n[Missing](missing.md)\n\n[Outside](../outside.md)" },
  { documentId: "kanban", fileName: "KANBAN.md", contents: "# Root board" },
  { documentId: "generated-retry", fileName: "plans/retries/PLAN.md", contents: "# Retry plan\n\n[Sibling board](../../kanban/retries/KANBAN.md)" },
  { documentId: "generated-other", fileName: "plans/other/PLAN.md", contents: "# Other plan" },
  { documentId: "generated-board", fileName: "kanban/retries/KANBAN.md", contents: "# Retry board" },
].map(document => ({ ...document, documentId: document.documentId as WorkspacePlanningDocumentId, workspaceId, sha256: `sha256:${"a".repeat(64)}` }));
function setup() {
  const fake = fakeWorkspaceClient();
  const list = vi.fn(async () => ({ workspaceId, documents: documents.map(({ documentId, fileName }) => ({ documentId, fileName })) }));
  const read = vi.fn(async (_workspaceId: string, id: WorkspacePlanningDocumentId) => documents.find(item => item.documentId === id)!);
  const update = vi.fn(async (_workspaceId: string, id: WorkspacePlanningDocumentId, _sha: string, contents: string) => ({ ...documents.find(item => item.documentId === id)!, contents }));
  Object.assign(fake.client, { listWorkspacePlanningDocuments: list, readWorkspacePlanningDocument: read,
    updateWorkspacePlanningDocument: update, listWorkspaceReviewThreads: vi.fn(async () => ({ workspaceId, threads: [] })) });
  return { ...fake, read, update };
}
const panel = (client: ReturnType<typeof setup>["client"]) => <PlanningDocumentsPanel client={client} workspaceId={workspaceId} workspaceKey="NESTED" />;
beforeEach(() => localStorage.clear());

describe("nested planning files", () => {
  it("keeps local document actions from exposing an app-relative browser route", async () => {
    const user = userEvent.setup(); const fake = setup(); render(panel(fake.client));
    await screen.findByRole("heading", { name: "Root plan" });
    expect(screen.queryByRole("link", { name: "Retry plan" })).not.toBeInTheDocument();
    const target = screen.getByRole("button", { name: "Retry plan" });
    expect(target).not.toHaveAttribute("href");
    target.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("heading", { name: "Retry plan" });
    expect(fake.read).toHaveBeenLastCalledWith(workspaceId, "generated-retry");
  });
  it("groups plans and boards by folder and saves the exact duplicate filename", async () => {
    const user = userEvent.setup(); const fake = setup(); render(panel(fake.client));
    const files = await screen.findByRole("navigation", { name: "Planning files" });
    const retryFolder = within(files).getByRole("group", { name: "plans/retries folder" });
    expect(within(retryFolder).getByRole("button", { name: "plans/retries/PLAN.md" })).toHaveTextContent("PLAN.md");
    await user.click(within(retryFolder).getByRole("button", { name: "plans/retries/PLAN.md" }));
    await screen.findByRole("heading", { name: "Retry plan" });
    expect(fake.read).toHaveBeenLastCalledWith(workspaceId, "generated-retry");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Edit plans/retries/PLAN.md" });
    await user.clear(editor); await user.type(editor, "# Updated retry plan");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fake.update).toHaveBeenCalledWith(workspaceId, "generated-retry", documents[2]!.sha256, "# Updated retry plan"));
  });
  it("searches full paths and reveals matches inside a collapsed folder without losing its saved state", async () => {
    const user = userEvent.setup(); const fake = setup(); const view = render(panel(fake.client));
    const collapse = await screen.findByRole("button", { name: "Collapse plans folder" });
    await user.click(collapse);
    expect(screen.queryByRole("button", { name: "plans/retries/PLAN.md" })).not.toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search planning files" });
    await user.type(search, "plans/retries");
    expect(screen.getByRole("button", { name: "plans/retries/PLAN.md" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "plans/other/PLAN.md" })).not.toBeInTheDocument();
    await user.clear(search);
    expect(screen.queryByRole("button", { name: "plans/retries/PLAN.md" })).not.toBeInTheDocument();
    view.unmount(); render(panel(fake.client));
    await screen.findByRole("button", { name: "Expand plans folder" });
    expect(screen.queryByRole("button", { name: "plans/retries/PLAN.md" })).not.toBeInTheDocument();
  });
  it("opens relative links in the current viewer and keeps unsent feedback", async () => {
    const user = userEvent.setup(); const fake = setup(); render(panel(fake.client));
    await user.click(await screen.findByRole("button", { name: "Retry plan" }));
    await screen.findByRole("heading", { name: "Retry plan" });
    await user.type(screen.getByRole("textbox", { name: "Feedback for plans/retries/PLAN.md" }), "Keep this feedback.");
    await user.click(screen.getByRole("button", { name: "Sibling board" }));
    expect(screen.getByText("Add or clear your feedback before you open another file.")).toBeVisible();
    expect(fake.read).not.toHaveBeenCalledWith(workspaceId, "generated-board");
    await user.clear(screen.getByRole("textbox", { name: "Feedback for plans/retries/PLAN.md" }));
    await user.click(screen.getByRole("button", { name: "Sibling board" }));
    await screen.findByRole("heading", { name: "Retry board" });
    expect(fake.read).toHaveBeenLastCalledWith(workspaceId, "generated-board");
  });
  it("reveals a linked file hidden by search and a collapsed folder", async () => {
    const user = userEvent.setup(); const fake = setup(); render(panel(fake.client));
    await user.click(await screen.findByRole("button", { name: "Retry plan" }));
    await screen.findByRole("heading", { name: "Retry plan" });
    await user.click(screen.getByRole("button", { name: "Collapse kanban folder" }));
    const search = screen.getByRole("searchbox", { name: "Search planning files" });
    await user.type(search, "plans/retries");
    await user.click(screen.getByRole("button", { name: "Sibling board" }));
    await screen.findByRole("heading", { name: "Retry board" });
    expect(search).toHaveValue("");
    expect(screen.getByRole("button", { name: "kanban/retries/KANBAN.md" })).toHaveAttribute("aria-current", "page");
  });
  it("keeps unknown or escaping local links from navigating out of WTS", async () => {
    const fake = setup(); render(panel(fake.client)); await screen.findByRole("heading", { name: "Root plan" });
    expect(screen.queryByRole("link", { name: "Missing" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Outside" })).not.toBeInTheDocument();
    expect(screen.getByText("Missing")).toBeVisible(); expect(screen.getByText("Outside")).toBeVisible();
  });
  it("excludes collapsed descendants from keyboard navigation and select-all", async () => {
    const user = userEvent.setup(); const fake = setup(); render(panel(fake.client));
    await user.click(await screen.findByRole("button", { name: "Collapse plans folder" }));
    await user.click(screen.getByRole("button", { name: "Collapse kanban folder" }));
    const root = screen.getByRole("button", { name: "PLAN.md" });
    fireEvent.keyDown(root, { key: "End" });
    await screen.findByRole("heading", { name: "Root board" });
    expect(fake.read).toHaveBeenLastCalledWith(workspaceId, "kanban");
    await user.click(screen.getByRole("checkbox", { name: "Select all visible planning files" }));
    expect(screen.getByRole("toolbar", { name: "Planning file selection actions" })).toHaveTextContent("2 selected");
  });
});
