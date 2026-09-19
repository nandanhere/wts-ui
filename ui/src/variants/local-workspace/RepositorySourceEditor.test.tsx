import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceClientError } from "../../lib/wtsClient";
import userEvent from "@testing-library/user-event";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import { RepositorySourceEditor } from "./RepositorySourceEditor";

function fixture() {
  const fake = fakeWorkspaceClient();
  const source = { schemaVersion: 1 as const, workspaceId: "ws_edit", repositoryId: "repo_checkout", filePath: "src/checkout.ts", content: "export const retries = 1;\n", revision: `sha256:${"a".repeat(64)}` };
  const getWorkspaceRepositorySource = vi.fn().mockResolvedValue(source);
  const saveWorkspaceRepositorySource = vi.fn().mockImplementation(async (_workspace, _repository, request) => ({ ...source, content: request.content, revision: `sha256:${"b".repeat(64)}` }));
  const client = { ...fake.client, getWorkspaceRepositorySource, saveWorkspaceRepositorySource };
  const props = { client, workspaceId: source.workspaceId, repositoryId: source.repositoryId, filePath: source.filePath, refreshToken: 0, active: true, onSaved: vi.fn() };
  return { source, client, props, getWorkspaceRepositorySource, saveWorkspaceRepositorySource };
}

async function edit(text: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Edit locally" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Local file editor" }), { target: { value: text } });
}

describe("local source editor", () => {
  it.each([false, true])("shows current source without starting an editor in a native preview (embedded=%s)", async embedded => {
    const f = fixture();
    Object.defineProperty(window, "__WTS_NATIVE_PREVIEW__", { configurable: true, value: { schemaVersion: 1, allowedCommands: ["get_workspace_repository_source"] } });
    try {
      render(<RepositorySourceEditor {...f.props} embedded={embedded} />);
      await screen.findByText(f.source.content.trim());
      expect(screen.queryByRole("button", { name: "Edit locally" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save local file" })).not.toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: "Local file editor" })).not.toBeInTheDocument();
      expect(screen.getByText("This preview is read-only. Use the main WTS window to make changes.")).toBeVisible();
      expect(f.saveWorkspaceRepositorySource).not.toHaveBeenCalled();
    } finally { Reflect.deleteProperty(window, "__WTS_NATIVE_PREVIEW__"); }
  });

  it.each(["preview_read_only", "native_preview_read_only"])("preserves a rejected source draft without impossible recovery actions for %s", async code => {
    const user = userEvent.setup(); const f = fixture();
    f.saveWorkspaceRepositorySource.mockRejectedValue(new WorkspaceClientError("Native preview rejected this write.", { code }));
    const view = render(<RepositorySourceEditor {...f.props} />);
    await edit("Keep this source draft");
    await user.click(screen.getByRole("button", { name: "Save local file" }));
    await screen.findByText("This preview is read-only. Use the main WTS window to make changes.");
    expect(screen.queryByRole("button", { name: "Save local file" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Read file again" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy draft" }));
    expect(await navigator.clipboard.readText()).toBe("Keep this source draft");
    view.unmount(); render(<RepositorySourceEditor {...f.props} />);
    expect(await screen.findByRole("textbox", { name: "Local file editor" })).toHaveValue("Keep this source draft");
    expect(screen.getByRole("textbox", { name: "Local file editor" })).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Save local file" })).not.toBeInTheDocument();
    expect(f.saveWorkspaceRepositorySource).toHaveBeenCalledOnce();
  });

  it.each(["repository_file_unavailable", "repository_file_not_text", "repository_file_too_large"])("offers VS Code instead of a read loop for %s", async (code) => {
    const f = fixture();
    f.getWorkspaceRepositorySource.mockRejectedValue(new WorkspaceClientError("This file cannot be opened here.", { code }));
    vi.mocked(f.client.openWorkspaceInVscode).mockResolvedValue({ provider: "vsCode", accepted: true, workspaceId: "ws_edit", codeWorkspaceDisplayPath: "/tmp/work.code-workspace" });
    render(<RepositorySourceEditor {...f.props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open workspace in VS Code" }));
    expect(f.client.openWorkspaceInVscode).toHaveBeenCalledWith("ws_edit");
    expect(screen.queryByRole("button", { name: "Read file again" })).not.toBeInTheDocument();
    expect(f.getWorkspaceRepositorySource).toHaveBeenCalledOnce();
  });

  it("keeps the failed save draft available for manual copy when clipboard access fails", async () => {
    userEvent.setup();
    const f = fixture();
    f.saveWorkspaceRepositorySource.mockRejectedValue(new WorkspaceClientError("File unavailable.", { code: "repository_file_unavailable" }));
    const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Permission denied"));
    try {
      render(<RepositorySourceEditor {...f.props} />);
      await edit("Keep this unsaved source");
      fireEvent.click(screen.getByRole("button", { name: "Save local file" }));
      fireEvent.click(await screen.findByRole("button", { name: "Copy draft" }));
      expect(await screen.findByText("Clipboard access failed. Select the draft text below, then copy it.")).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Local file editor" })).toHaveValue("Keep this unsaved source");
      expect(f.saveWorkspaceRepositorySource).toHaveBeenCalledOnce();
    } finally { clipboard.mockRestore(); }
  });

  it("keeps newer-file comparison open during a background refresh", async () => {
    const f = fixture();
    const view = render(<RepositorySourceEditor {...f.props} />);
    await edit("Keep this draft.");
    f.getWorkspaceRepositorySource.mockResolvedValue({ ...f.source, content: "New agent content", revision: `sha256:${"f".repeat(64)}` });
    view.rerender(<RepositorySourceEditor {...f.props} refreshToken={1} />);
    fireEvent.click(await screen.findByRole("button", { name: "Compare newer file" }));
    expect(screen.getByLabelText("Newer local file")).toBeVisible();
    view.rerender(<RepositorySourceEditor {...f.props} refreshToken={2} />);
    await waitFor(() => expect(f.getWorkspaceRepositorySource).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText("Newer local file")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Local file editor" })).toHaveValue("Keep this draft.");
  });

  it("releases a clean saved cache entry when a superseded read remains pending", async () => {
    const f = fixture();
    let resolveSave!: (value: typeof f.source) => void;
    const save = new Promise<typeof f.source>((resolve) => { resolveSave = resolve; });
    f.saveWorkspaceRepositorySource.mockReturnValueOnce(save);
    f.getWorkspaceRepositorySource.mockResolvedValueOnce(f.source).mockImplementation(() => new Promise(() => undefined));
    const first = render(<RepositorySourceEditor {...f.props} />);
    await edit("saved content");
    fireEvent.click(screen.getByRole("button", { name: "Save local file" }));
    first.rerender(<RepositorySourceEditor {...f.props} refreshToken={1} />);
    await waitFor(() => expect(f.getWorkspaceRepositorySource).toHaveBeenCalledTimes(2));
    await act(async () => { resolveSave({ ...f.source, content: "saved content", revision: `sha256:${"e".repeat(64)}` }); await save; });
    first.unmount();
    for (let index = 0; index < 63; index += 1) {
      const view = render(<RepositorySourceEditor {...f.props} filePath={`src/file-${index}.ts`} />);
      view.unmount();
    }
    render(<RepositorySourceEditor {...f.props} filePath="src/last.ts" />);
    expect(f.getWorkspaceRepositorySource).toHaveBeenCalledTimes(66);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps adopted newer content when an earlier refresh finishes later", async () => {
    const f = fixture();
    let resolveRecovery!: (value: typeof f.source) => void;
    let resolveRefresh!: (value: typeof f.source) => void;
    const recovery = new Promise<typeof f.source>((resolve) => { resolveRecovery = resolve; });
    const refresh = new Promise<typeof f.source>((resolve) => { resolveRefresh = resolve; });
    f.getWorkspaceRepositorySource.mockResolvedValueOnce(f.source).mockReturnValueOnce(recovery).mockReturnValueOnce(refresh);
    f.saveWorkspaceRepositorySource.mockRejectedValueOnce(new WorkspaceClientError("The file changed.", { code: "repository_file_conflict" }));
    const view = render(<RepositorySourceEditor {...f.props} />);
    await edit("Keep my draft until I choose newer content.");
    fireEvent.click(screen.getByRole("button", { name: "Save local file" }));
    await waitFor(() => expect(f.getWorkspaceRepositorySource).toHaveBeenCalledTimes(2));
    view.rerender(<RepositorySourceEditor {...f.props} refreshToken={1} />);
    await waitFor(() => expect(f.getWorkspaceRepositorySource).toHaveBeenCalledTimes(3));
    const newer = { ...f.source, content: "newer accepted content", revision: `sha256:${"f".repeat(64)}` };
    await act(async () => { resolveRecovery(newer); await recovery; });
    fireEvent.click(screen.getByRole("button", { name: "Use newer file" }));
    await act(async () => { resolveRefresh(f.source); await refresh; });
    expect(screen.getByRole("textbox", { name: "Local file editor" })).toHaveValue("newer accepted content");
  });

  it("ignores conflict recovery content that arrives after a successful retry", async () => {
    const f = fixture();
    let resolve!: (value: typeof f.source) => void;
    const recovery = new Promise<typeof f.source>((next) => { resolve = next; });
    f.getWorkspaceRepositorySource.mockResolvedValueOnce(f.source).mockReturnValueOnce(recovery);
    f.saveWorkspaceRepositorySource.mockRejectedValueOnce(new WorkspaceClientError("The file changed.", { code: "repository_file_conflict" }));
    render(<RepositorySourceEditor {...f.props} />);
    await edit("My saved retry\n");
    fireEvent.click(screen.getByRole("button", { name: "Save local file" }));
    await waitFor(() => expect(f.getWorkspaceRepositorySource).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Save local file" }));
    await waitFor(() => expect(f.props.onSaved).toHaveBeenCalledOnce());
    await act(async () => { resolve({ ...f.source, content: "obsolete agent content", revision: `sha256:${"c".repeat(64)}` }); await recovery; });
    expect(screen.queryByRole("button", { name: "Use newer file" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Local file editor" })).toHaveValue("My saved retry\n");
  });

  it("bounds pending file reads instead of evicting and recreating their draft entries", () => {
    const f = fixture();
    f.getWorkspaceRepositorySource.mockImplementation(() => new Promise(() => undefined));
    for (let index = 0; index < 64; index += 1) {
      const view = render(<RepositorySourceEditor {...f.props} filePath={`src/file-${index}.ts`} />);
      view.unmount();
    }
    render(<RepositorySourceEditor {...f.props} filePath="src/overflow.ts" />);
    expect(f.getWorkspaceRepositorySource).toHaveBeenCalledTimes(64);
    expect(screen.getByRole("alert")).toHaveTextContent("WTS retained your drafts");
  });

  it("saves the local file with its captured revision and does not publish it", async () => {
    const f = fixture(); render(<RepositorySourceEditor {...f.props} />);
    await edit("export const retries = 3;\n");
    fireEvent.click(screen.getByRole("button", { name: "Save local file" }));
    await waitFor(() => expect(f.props.onSaved).toHaveBeenCalledOnce());
    expect(f.saveWorkspaceRepositorySource).toHaveBeenCalledWith("ws_edit", "repo_checkout", { filePath: "src/checkout.ts", content: "export const retries = 3;\n", expectedRevision: f.source.revision });
    expect(screen.getByText("Local file saved. The MR is unchanged.")).toBeVisible();
  });

  it("keeps the draft and rejects overwrite when an agent changes the same file", async () => {
    const f = fixture();
    const newer = { ...f.source, content: "export const retries = 5;\n", revision: `sha256:${"c".repeat(64)}` };
    f.saveWorkspaceRepositorySource.mockRejectedValueOnce(new WorkspaceClientError("The file changed. Reload it before saving.", { code: "repository_file_conflict" }));
    const view = render(<RepositorySourceEditor {...f.props} />);
    await edit("export const retries = 3;\n");
    f.getWorkspaceRepositorySource.mockResolvedValue(newer);
    view.rerender(<RepositorySourceEditor {...f.props} refreshToken={1} />);
    expect(await screen.findByText("The local file changed while you edited it. Your draft is unchanged.")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Local file editor" })).toHaveValue("export const retries = 3;\n");
    fireEvent.click(screen.getByRole("button", { name: "Save local file" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The file changed");
    expect(f.saveWorkspaceRepositorySource.mock.calls[0]![2].expectedRevision).toBe(f.source.revision);
    expect(f.props.onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Compare newer file" }));
    expect(screen.getByLabelText("Newer local file")).toHaveTextContent("export const retries = 5;");
    fireEvent.click(screen.getByRole("button", { name: "Use newer file" }));
    expect(screen.getByRole("textbox", { name: "Local file editor" })).toHaveValue(newer.content);
  });

  it("retains the editor draft across workspace visits without sharing it with another file", async () => {
    const f = fixture();
    const first = render(<RepositorySourceEditor {...f.props} />);
    await edit("Keep this local draft.\n"); first.unmount();
    const second = render(<RepositorySourceEditor {...f.props} filePath="src/other.ts" />);
    expect(screen.queryByRole("textbox", { name: "Local file editor" })).not.toBeInTheDocument();
    second.unmount();
    render(<RepositorySourceEditor {...f.props} />);
    expect(await screen.findByRole("textbox", { name: "Local file editor" })).toHaveValue("Keep this local draft.\n");
    expect(f.saveWorkspaceRepositorySource).not.toHaveBeenCalled();
  });

  it("shows an unavailable file without offering an editor", async () => {
    const f = fixture(); f.getWorkspaceRepositorySource.mockRejectedValue(new Error("The file is binary or unavailable."));
    render(<RepositorySourceEditor {...f.props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("binary or unavailable");
    expect(screen.queryByRole("button", { name: "Edit locally" })).not.toBeInTheDocument();
  });
});
