import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceClient } from "./wtsClient";

const workspaceId = "5546754b-6acd-4890-b7b4-acb54e5ec8b7";
const document = { workspaceId, documentId: "plan" as const, fileName: "PLAN.md", contents: "# Saved plan\n", sha256: `sha256:${"a".repeat(64)}` };

afterEach(() => {
  Reflect.deleteProperty(window, "__WTS_NATIVE_PREVIEW__");
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

function nativeClient(preview: boolean) {
  const dispatch = vi.fn(async () => document);
  const internals = {};
  Object.defineProperty(internals, "invoke", { value: dispatch });
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: internals, configurable: true });
  if (preview) Object.defineProperty(window, "__WTS_NATIVE_PREVIEW__", { value: Object.freeze({ schemaVersion: 1, allowedCommands: Object.freeze(["read_workspace_planning_document"]) }), configurable: true });
  return { dispatch, internals, client: createWorkspaceClient({ runtime: "tauri" }) };
}

describe("native preview through the WTS client", () => {
  it("reads Plans through Tauri's immutable invoke without changing its descriptor", async () => {
    const { client, dispatch, internals } = nativeClient(true);
    await expect(client.readWorkspacePlanningDocument(workspaceId, "plan")).resolves.toEqual(document);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("read_workspace_planning_document", { workspaceId, documentId: "plan" }, undefined);
    expect(Object.getOwnPropertyDescriptor(internals, "invoke")).toMatchObject({ writable: false, configurable: false });
  });

  it("gives read-only guidance before a Plans write reaches native IPC", async () => {
    const { client, dispatch } = nativeClient(true);
    await expect(client.updateWorkspacePlanningDocument(workspaceId, "plan", document.sha256, "Private draft")).rejects.toMatchObject({ code: "preview_read_only", message: "This preview is read-only. Use the main WTS window to make changes.", retryable: false });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("blocks commands outside the host allowlist without a false host-connection error", async () => {
    const { client, dispatch } = nativeClient(true);
    await expect(client.getWorkspace(workspaceId)).rejects.toMatchObject({ code: "preview_read_only", retryable: false });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps normal main-window writes available", async () => {
    const { client, dispatch } = nativeClient(false);
    await expect(client.updateWorkspacePlanningDocument(workspaceId, "plan", document.sha256, "Private draft")).resolves.toEqual(document);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("update_workspace_planning_document", { workspaceId, documentId: "plan", request: { expectedSha256: document.sha256, contents: "Private draft" } }, undefined);
  });
});
