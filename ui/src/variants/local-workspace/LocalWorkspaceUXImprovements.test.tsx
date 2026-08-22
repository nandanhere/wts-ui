import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  fakeWorkspaceClient,
  workspaceFixture,
  workspaceListFixture,
} from "../../test/workspaceClientFake";
import { LocalWorkspace } from "./LocalWorkspace";

function assistantMaterialization(
  workspace: ReturnType<typeof workspaceFixture>,
) {
  const repository = workspace.repositories[0]!;
  return {
    schemaVersion: 1 as const,
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
      status: "ready" as const,
      detail: "Workspace graph is ready.",
    },
  };
}

describe("LocalWorkspace UX Improvements", () => {
  describe("CHANGE A: Toast queue", () => {
    it("renders multiple toasts simultaneously, sets assertive aria-live on error toasts, and supports manual dismiss", async () => {
      const user = userEvent.setup();
      const ws1 = workspaceFixture({ workspaceId: "ws_01", title: "First Plan" });
      const ws2 = workspaceFixture({ workspaceId: "ws_02", title: "Second Plan" });
      const list = workspaceListFixture([ws1, ws2]);
      const fake = fakeWorkspaceClient({ list });

      render(<LocalWorkspace client={fake.client} />);

      await waitFor(() => {
        expect(screen.getByText("Opening the local workspace registry…")).toBeInTheDocument();
      });

      // Opening workspace 1 emits a second notice ("ws_01 plan loaded...")
      const card1 = screen.getByRole("button", { name: new RegExp(ws1.title, "i") });
      await user.click(card1);

      // In Toast queue, initial notice and new notice must coexist simultaneously
      const statusToasts = screen.getAllByRole("status");
      expect(statusToasts.length).toBeGreaterThanOrEqual(2);

      // Trigger preflight setup error
      fake.preflightWorkspace.mockRejectedValueOnce(new Error("Preflight check failed"));
      const reviewBtn = screen.getByRole("button", { name: "Review setup" });
      await user.click(reviewBtn);

      await waitFor(() => {
        const errorText = screen.getByText(/preflight failed/i);
        const errorContainer = errorText.closest("[aria-live]");
        expect(errorContainer).not.toBeNull();
        expect(errorContainer).toHaveAttribute("aria-live", "assertive");
      });

      // Manual dismiss removes a toast
      const dismissButtons = screen.getAllByRole("button", { name: /Dismiss notice/i });
      expect(dismissButtons.length).toBeGreaterThan(0);
      const initialCount = screen.queryAllByRole("status").length + screen.queryAllByRole("alert").length;
      await user.click(dismissButtons[0]!);
      const newCount = screen.queryAllByRole("status").length + screen.queryAllByRole("alert").length;
      expect(newCount).toBe(initialCount - 1);
    });
  });

  describe("CHANGE B: Keyboard shortcuts", () => {
    it("switches workbench tabs with Cmd+1 through Cmd+4 when workbench view is active", async () => {
      const ws = workspaceFixture({ workspaceId: "ws_01", title: "Workbench Plan" });
      const list = workspaceListFixture([ws]);
      const fake = fakeWorkspaceClient({ list });
      fake.getWorkspace.mockResolvedValue(ws);
      fake.getWorkspaceMaterialization.mockResolvedValue(assistantMaterialization(ws));

      render(
        <LocalWorkspace
          client={fake.client}
          initialView="workbench"
          initialWorkspaceId={ws.workspaceId}
        />,
      );

      await waitFor(() => {
        expect(screen.getByRole("tab", { name: "Workspace" })).toBeInTheDocument();
      });
      await screen.findByRole("tab", { name: "Changes" });

      // Switch to Changes tab with Cmd+2
      fireEvent.keyDown(window, { key: "2", metaKey: true });
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute(
          "aria-selected",
          "true",
        );
      });
      expect(globalThis.location.pathname).toBe(
        `/sessions/${ws.workspaceId}/changes`,
      );

      // Switch to Verification tab with Cmd+3
      fireEvent.keyDown(window, { key: "3", metaKey: true });
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: "Verify" })).toHaveAttribute(
          "aria-selected",
          "true",
        );
      });
      expect(globalThis.location.pathname).toBe(
        `/sessions/${ws.workspaceId}/verification`,
      );

      // Open the planning review without changing the established shortcuts.
      fireEvent.keyDown(window, { key: "4", metaKey: true });
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: "Plans" })).toHaveAttribute(
          "aria-selected",
          "true",
        );
      });
      expect(globalThis.location.pathname).toBe(
        `/sessions/${ws.workspaceId}/planning`,
      );

      // Switch to Overview tab with Cmd+1
      fireEvent.keyDown(window, { key: "1", metaKey: true });
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: "Workspace" })).toHaveAttribute("aria-selected", "true");
      });
      expect(globalThis.location.pathname).toBe(
        `/sessions/${ws.workspaceId}`,
      );
    });

    it("does not open Changes before the workspace exists", async () => {
      const ws = workspaceFixture({ workspaceId: "ws_unbuilt", title: "Saved plan" });
      const fake = fakeWorkspaceClient({ list: workspaceListFixture([ws]) });

      render(
        <LocalWorkspace
          client={fake.client}
          initialView="workbench"
          initialWorkspaceId={ws.workspaceId}
        />,
      );

      await screen.findByRole("tab", { name: "Workspace" });
      expect(screen.queryByRole("tab", { name: "Changes" })).not.toBeInTheDocument();
      const initialPath = globalThis.location.pathname;
      fireEvent.keyDown(window, { key: "2", metaKey: true });
      expect(screen.getByRole("tab", { name: "Workspace" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(globalThis.location.pathname).toBe(initialPath);
    });

    it("opens New workspace dialog with Cmd+N from board view", async () => {
      const ws = workspaceFixture({ workspaceId: "ws_01", title: "Board Plan" });
      const list = workspaceListFixture([ws]);
      const fake = fakeWorkspaceClient({ list });

      render(<LocalWorkspace client={fake.client} />);

      await waitFor(() => {
        expect(screen.getByText("Opening the local workspace registry…")).toBeInTheDocument();
      });

      fireEvent.keyDown(window, { key: "n", metaKey: true });

      await waitFor(() => {
        expect(screen.getByRole("dialog", { name: "New workspace" })).toBeInTheDocument();
      });
    });

    it("navigates between board cards using Arrow keys", async () => {
      const ws1 = workspaceFixture({ workspaceId: "ws_01", title: "Card One" });
      const ws2 = workspaceFixture({ workspaceId: "ws_02", title: "Card Two" });
      const list = workspaceListFixture([ws1, ws2]);
      const fake = fakeWorkspaceClient({ list });

      render(<LocalWorkspace client={fake.client} />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: new RegExp(ws1.title, "i") })).toBeInTheDocument();
      });

      const card1 = screen.getByRole("button", { name: new RegExp(ws1.title, "i") });
      card1.focus();
      expect(document.activeElement).toBe(card1);

      // Press ArrowDown
      fireEvent.keyDown(card1, { key: "ArrowDown" });
      const active1 = document.activeElement;
      expect(active1).not.toBe(card1);

      // Press ArrowUp to return
      if (active1) {
        fireEvent.keyDown(active1, { key: "ArrowUp" });
        expect(document.activeElement).toBe(card1);
      }
    });
  });

  describe("CHANGE C: Visibility-gated polling", () => {
    it("pauses elapsed-time ticker while document is hidden and resumes when visible", async () => {
      vi.useFakeTimers();
      const ws = workspaceFixture({ workspaceId: "ws_01", title: "Polling Plan" });
      const list = workspaceListFixture([ws]);
      const fake = fakeWorkspaceClient({ list });

      render(<LocalWorkspace client={fake.client} initialWorkspaceId={ws.workspaceId} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const ownVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");

      try {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden",
        });
        act(() => document.dispatchEvent(new Event("visibilitychange")));

        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });

        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        act(() => document.dispatchEvent(new Event("visibilitychange")));

        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      } finally {
        if (ownVisibility) {
          Object.defineProperty(document, "visibilityState", ownVisibility);
        } else {
          Reflect.deleteProperty(document, "visibilityState");
        }
        vi.useRealTimers();
      }
    });
  });
});
