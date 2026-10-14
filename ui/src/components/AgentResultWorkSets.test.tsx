import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResultWorkSets } from "./AgentResultWorkSets";
import type { WorkspaceClient } from "../lib/wtsClient";
import { WorkspaceClientError } from "../lib/wtsClient";
import { agentTurnChangesFixture } from "../test/agentTurnChangesFixture";
import { agentWorkChildFixture, agentWorkSetFixture, WORK_SET_ID, WORK_TASK_ID } from "../test/agentWorkSetsFixture";
import type { AgentWorkSet, CreateAgentWorkSetRequest } from "../lib/agentWorkSets";
vi.mock("../variants/local-workspace/RepositoryPatchViewer", () => ({ RepositoryPatchViewer: (props: { patch: string; calloutPrefix: { id: string; label: string } }) => <pre data-ui={`${props.calloutPrefix.id}.code`} data-ui-label={`${props.calloutPrefix.label} code`}>{props.patch}</pre> }));
const receipt = agentTurnChangesFixture();
function fixture(sets: AgentWorkSet[] = []) {
  const client = { listAgentWorkSets: vi.fn().mockResolvedValue({ schemaVersion: 1, conversationId: receipt.conversationId, requestId: receipt.requestId, workSets: sets }), getAgentWorkSet: vi.fn().mockImplementation(async id => sets.find(set => set.workSetId === id)), createAgentWorkSet: vi.fn().mockImplementation(async (_id, _turn, request: CreateAgentWorkSetRequest) => agentWorkSetFixture({ workSetId: request.requestId, kind: request.kind, tasks: request.tasks.map((task: import("../lib/agentWorkSets").AgentWorkItemPlan) => ({ ...task, state: "queued", conversationId: crypto.randomUUID(), requestId: crypto.randomUUID(), detail: "Queued." })) })), cancelAgentWorkItem: vi.fn(), getAgentConversation: vi.fn().mockResolvedValue(agentWorkChildFixture()), getAgentTurnChanges: vi.fn().mockResolvedValue({ ...receipt, conversationId: agentWorkChildFixture().conversationId, requestId: WORK_TASK_ID, workspaceId: agentWorkChildFixture().workspaceId, repositoryId: agentWorkChildFixture().repositoryId }), openAgentWorkItemPreview: vi.fn() };
  const props = { client: client as unknown as WorkspaceClient, receipt, onLeaveReview: vi.fn() }; return { client, props };
}
async function open() { fireEvent.click(screen.getByText(/^Tasks and alternatives/)); await waitFor(() => expect(screen.getByRole("button", { name: "Refresh plans" })).toBeEnabled()); }
async function fill() { fireEvent.change(screen.getByRole("textbox", { name: "Task title 1" }), { target: { value: "Compact header" } }); fireEvent.change(screen.getByRole("textbox", { name: "Task prompt 1" }), { target: { value: "Keep the code visible." } }); }
beforeEach(() => localStorage.clear());
describe("result task plans", () => {
  it("does not replace an unfinished plan when reusing a saved plan", async () => {
    const { props } = fixture([agentWorkSetFixture()]); render(<AgentResultWorkSets {...props} />); await open(); await fill();
    expect(screen.getByRole("button", { name: "Use this plan again" })).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "Use this plan again" })); expect(screen.getByRole("textbox", { name: "Task prompt 1" })).toHaveValue("Keep the code visible.");
    fireEvent.click(screen.getByRole("button", { name: "Discard task plan" })); expect(screen.getByRole("button", { name: "Use this plan again" })).toBeEnabled(); fireEvent.click(screen.getByRole("button", { name: "Use this plan again" })); expect(screen.getByRole("textbox", { name: "Task prompt 1" })).toHaveValue("Keep the composer visible.");
  });
  it("treats an unfinished dependency choice as a draft even without text", async () => {
    const { props } = fixture([agentWorkSetFixture()]); render(<AgentResultWorkSets {...props} />); await open(); fireEvent.click(screen.getByRole("button", { name: "Add task" })); fireEvent.click(screen.getByRole("checkbox", { name: "Task 1" })); expect(screen.getByRole("button", { name: "Use this plan again" })).toBeDisabled();
  });
  it("keeps preview unavailable until the candidate completes", async () => {
    const set = agentWorkSetFixture(); set.tasks[0].state = "queued"; const { props } = fixture([set]); render(<AgentResultWorkSets {...props} />); await open(); await screen.findByText("Queued"); expect(screen.queryByRole("button", { name: "Open live preview" })).not.toBeInTheDocument(); expect(screen.getByRole("link", { name: "Open task workspace" })).toBeVisible();
  });

  it("retains an unsent plan across remount without launching it", async () => {
    const { client, props } = fixture(); const view = render(<AgentResultWorkSets {...props} />); await open(); await fill(); view.unmount(); render(<AgentResultWorkSets {...props} />); await open();
    expect(screen.getByRole("textbox", { name: "Task prompt 1" })).toHaveValue("Keep the code visible."); expect(client.createAgentWorkSet).not.toHaveBeenCalled();
  });
  it("reconciles a lost create acknowledgement on reload without launching twice", async () => {
    const { client, props } = fixture(); let accepted: AgentWorkSet | undefined;
    client.createAgentWorkSet.mockImplementation(async (_id, _turn, request) => { accepted = agentWorkSetFixture({ workSetId: request.requestId, tasks: request.tasks.map((task: import("../lib/agentWorkSets").AgentWorkItemPlan) => ({ ...task, conversationId: crypto.randomUUID(), requestId: task.taskId, state: "queued", detail: "Queued." })) }); throw new Error("Connection lost."); });
    const view = render(<AgentResultWorkSets {...props} />); await open(); await fill(); fireEvent.click(screen.getByRole("button", { name: "Start tasks" })); await screen.findByRole("button", { name: "Retry task plan" }); view.unmount();
    client.listAgentWorkSets.mockResolvedValue({ schemaVersion: 1, conversationId: receipt.conversationId, requestId: receipt.requestId, workSets: [accepted!] }); render(<AgentResultWorkSets {...props} />); await open(); await screen.findByText("WTS saved this task plan.");
    expect(screen.queryByRole("button", { name: "Retry task plan" })).not.toBeInTheDocument(); expect(client.createAgentWorkSet).toHaveBeenCalledTimes(1);
  });
  it("replays the same saved plan when a create response is unknown", async () => {
    const { client, props } = fixture(); client.createAgentWorkSet.mockRejectedValueOnce(new Error("Connection lost.")); render(<AgentResultWorkSets {...props} />); await open(); await fill(); fireEvent.click(screen.getByRole("button", { name: "Start tasks" })); await screen.findByText("Connection lost."); const first = client.createAgentWorkSet.mock.calls[0];
    fireEvent.click(screen.getByRole("button", { name: "Retry task plan" })); await waitFor(() => expect(client.createAgentWorkSet).toHaveBeenCalledTimes(2)); expect(client.createAgentWorkSet.mock.calls[1]).toEqual(first);
  });
  it("does not dispatch if the durable request cannot be saved", async () => {
    const { client, props } = fixture(); render(<AgentResultWorkSets {...props} />); await open(); await fill(); const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Full."); });
    fireEvent.click(screen.getByRole("button", { name: "Start tasks" })); await screen.findByText(/Check browser storage/); expect(client.createAgentWorkSet).not.toHaveBeenCalled(); storage.mockRestore();
  });
  it("keeps dependency IDs after an explicit plan and removes references to a removed task", async () => {
    const { client, props } = fixture(); render(<AgentResultWorkSets {...props} />); await open(); await fill(); fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Task title 2" }), { target: { value: "Check header" } }); fireEvent.change(screen.getByRole("textbox", { name: "Task prompt 2" }), { target: { value: "Test the header." } }); fireEvent.click(screen.getByRole("checkbox", { name: "Compact header" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove task 1" })); fireEvent.click(screen.getByRole("button", { name: "Start tasks" })); await waitFor(() => expect(client.createAgentWorkSet).toHaveBeenCalledTimes(1)); expect(client.createAgentWorkSet.mock.calls[0][2].tasks).toEqual([expect.objectContaining({ title: "Check header", dependsOn: [] })]);
  });
  it("retries the exact cancellation after remount and does not change another task", async () => {
    const set = agentWorkSetFixture(); set.tasks[0].state = "running"; const { client, props } = fixture([set]); client.cancelAgentWorkItem.mockRejectedValueOnce(new Error("Connection lost.")); const view = render(<AgentResultWorkSets {...props} />); await open(); fireEvent.click(await screen.findByRole("button", { name: "Cancel task" })); await screen.findByText("Connection lost."); const first = client.cancelAgentWorkItem.mock.calls[0]; view.unmount();
    client.cancelAgentWorkItem.mockImplementation(async (_id, _task, request) => ({ ...set, revision: 2, lastMutationRequestId: request.requestId, tasks: [{ ...set.tasks[0], state: "cancelled" }] })); render(<AgentResultWorkSets {...props} />); await open(); fireEvent.click(await screen.findByRole("button", { name: "Retry cancellation" })); await screen.findByText("Cancelled"); expect(client.cancelAgentWorkItem.mock.calls[1]).toEqual(first);
  });
  it("opens candidate recovery in its own workspace when desktop preview is unavailable", async () => {
    const set = agentWorkSetFixture(); const { client, props } = fixture([set]); client.openAgentWorkItemPreview.mockRejectedValue(new WorkspaceClientError("Open the task in the WTS desktop app.", { code: "preview_desktop_required" })); const events: unknown[] = []; const listener = (event: Event) => events.push((event as CustomEvent).detail); window.addEventListener("wts:open-agent-workspace", listener);
    render(<AgentResultWorkSets {...props} />); await open(); fireEvent.click(await screen.findByRole("button", { name: "Open live preview" })); await screen.findByText("Open the task in the WTS desktop app."); expect(client.openAgentWorkItemPreview).toHaveBeenCalledExactlyOnceWith(WORK_SET_ID, WORK_TASK_ID); fireEvent.click(screen.getByRole("link", { name: "Open task workspace" }));
    expect(events).toEqual([{ workspaceId: set.tasks[0].workspaceId, repositoryId: set.tasks[0].repositoryId }]); expect(props.onLeaveReview).toHaveBeenCalledOnce(); window.removeEventListener("wts:open-agent-workspace", listener);
  });
  it("rejects a preview from a different checkpoint", async () => {
    const set = agentWorkSetFixture(); const { client, props } = fixture([set]); client.openAgentWorkItemPreview.mockResolvedValue({ schemaVersion: 1, workSetId: set.workSetId, taskId: WORK_TASK_ID, workspaceId: set.tasks[0].workspaceId, repositoryId: set.tasks[0].repositoryId, afterCheckpointId: WORK_SET_ID, state: "running", url: "http://127.0.0.1:19422", title: "Other files", detail: "Wrong preview." }); render(<AgentResultWorkSets {...props} />); await open(); fireEvent.click(await screen.findByRole("button", { name: "Open live preview" })); await screen.findByText(/preview does not match this candidate/); expect(screen.queryByText("Wrong preview.")).not.toBeInTheDocument();
  });
  it("does not expose another task's conversation as this candidate", async () => {
    const { client, props } = fixture([agentWorkSetFixture()]); client.getAgentConversation.mockResolvedValue({ ...agentWorkChildFixture(), source: { kind: "ui", label: "Parent", calloutId: "parent", route: "/" } } as never); render(<AgentResultWorkSets {...props} />); await open(); fireEvent.click(await screen.findByRole("button", { name: "Read task result" })); await screen.findByText(/candidate result does not match/); expect(screen.queryByRole("button", { name: "Review changes" })).not.toBeInTheDocument();
  });
  it("reads a verified child's recorded patch with unique result callouts and returns focus", async () => {
    const user = userEvent.setup(); const { client, props } = fixture([agentWorkSetFixture()]); render(<><div data-ui="agent-result.dialog" data-ui-label="Task changes dialog" /><AgentResultWorkSets {...props} /></>); await open(); await user.click(await screen.findByRole("button", { name: "Read task result" })); const trigger = await screen.findByRole("button", { name: "Review changes" }); await user.click(trigger); const dialog = await screen.findByRole("dialog", { name: "Compact layout changes" }); await waitFor(() => expect(dialog.querySelector("pre")?.textContent).toBe(receipt.patch)); expect(client.getAgentTurnChanges).toHaveBeenCalledExactlyOnceWith(agentWorkChildFixture().conversationId, WORK_TASK_ID);
    const ids = Array.from(document.querySelectorAll("[data-ui]"), el => el.getAttribute("data-ui")); expect(new Set(ids).size).toBe(ids.length); await user.keyboard("{Escape}"); expect(trigger).toHaveFocus();
  });
});
