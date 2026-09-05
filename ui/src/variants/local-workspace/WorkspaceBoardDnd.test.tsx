import {
  DndContext,
  MouseSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
} from "@dnd-kit/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  AssignedReviewCard,
  DraggableWorkspaceCard,
  WORKSPACE_BOARD_ORDER_STORAGE_KEY,
  loadWorkspaceBoardOrder,
  placeWorkspaceOnBoard,
  reconcileWorkspaceBoardOrder,
  saveWorkspaceBoardOrder,
  workspacePlacementNeighbor,
} from "./WorkspaceBoardDnd";
import type { Workspace } from "./LocalWorkspace";

describe("workspace board order fallback", () => {
  function MouseDragContext({
    children,
    onDragStart,
  }: {
    children: ReactNode;
    onDragStart: (event: DragStartEvent) => void;
  }) {
    const sensors = useSensors(
      useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    );
    return (
      <DndContext onDragStart={onDragStart} sensors={sensors}>
        {children}
      </DndContext>
    );
  }

  it("labels a review card when the author changes an approved head", () => {
    render(
      <AssignedReviewCard
        onOpen={vi.fn()}
        onPrepare={vi.fn()}
        opening={false}
        preparing={false}
        review={{
          id: "mr-9",
          repositoryId: "repo_obx_api",
          repository: "sre-tools/obx-api",
          number: 9,
          title: "Validate the LogQL time range",
          authorLogin: "priya",
          sourceBranch: "SRETOOLS-6349",
          targetBranch: "develop",
          headCommitOid: "b".repeat(40),
          updatedAt: "2026-08-19T08:00:00Z",
          draft: false,
          reviewState: "changesAfterApproval",
          status: "open",
        }}
      />,
    );

    const status = screen.getByText("New changes after approval");
    expect(status).toBeVisible();
    expect(status.closest("article")).toHaveAttribute("data-status", "changed");
  });

  it("starts dragging from the card surface without a separate handle", async () => {
    const onDragStart = vi.fn();
    const workspace: Workspace = {
      id: "ws-drag",
      intent: { type: "repositorySet", label: "drag" },
      key: "drag",
      kind: "Repositories",
      title: "Drag this workspace",
      lane: "planned",
      workflowState: "ready",
      workflowRevision: 1,
      workflowUpdatedAtUnixMs: 1,
      workflowPersisted: true,
      lifecycleState: "notMaterialized",
      knownWorktreeCount: 0,
      observedAtUnixMs: 1,
      provider: "VS Code",
      repos: 1,
      repositoryPlans: [],
      observedWorkItems: [],
      path: "/tmp/drag",
      updated: "now",
      updatedAtUnixMs: 1,
      summary: "Ready",
    };

    render(
      <MouseDragContext onDragStart={onDragStart}>
        <DraggableWorkspaceCard
          displayLane="planned"
          index={0}
          onOpen={vi.fn()}
          workspace={workspace}
        />
      </MouseDragContext>,
    );

    expect(
      screen.queryByRole("button", { name: "Drag workspace drag" }),
    ).not.toBeInTheDocument();
    const cardSurface = screen.getByRole("button", { name: /Open drag:/ });
    fireEvent.mouseDown(cardSurface, {
      button: 0,
      clientX: 20,
      clientY: 20,
    });
    fireEvent.mouseMove(document, {
      buttons: 1,
      clientX: 28,
      clientY: 28,
    });
    await waitFor(() => expect(onDragStart).toHaveBeenCalledOnce());
  });

  it("shows a merged merge request as a separate board link", () => {
    const onOpenMergeRequest = vi.fn();
    const workspace: Workspace = {
      id: "ws-merged",
      intent: { type: "repositorySet", label: "Review acme/api !22" },
      key: "merged",
      kind: "Repositories",
      title: "Review acme/api !22",
      lane: "attention",
      workflowState: "review",
      workflowRevision: 2,
      workflowUpdatedAtUnixMs: 2,
      workflowPersisted: true,
      lifecycleState: "materialized",
      knownWorktreeCount: 1,
      observedAtUnixMs: 2,
      provider: "VS Code",
      repos: 1,
      repositoryPlans: [],
      observedWorkItems: [],
      path: "/tmp/merged",
      updated: "now",
      updatedAtUnixMs: 2,
      summary: "Review",
    };
    const mergeRequest = {
      id: "mr-22",
      repositoryId: "repo-api",
      projectPath: "acme/api",
      webUrl: "https://gitlab.example.com/acme/api/-/merge_requests/22",
      iid: 22,
      title: "Merge delivery",
      sourceBranch: "feat/delivery",
      targetBranch: "main",
      authorUsername: "alice",
      updatedAt: "2026-08-28T08:00:00Z",
      draft: false,
      status: "merged" as const,
    };

    render(
      <DndContext>
        <DraggableWorkspaceCard
          displayLane="attention"
          index={0}
          mergeRequests={[mergeRequest]}
          onOpen={vi.fn()}
          onOpenMergeRequest={onOpenMergeRequest}
          workspace={workspace}
        />
      </DndContext>,
    );

    const card = screen.getByRole("link", {
      name: "Open merge request !22 in GitLab",
    }).closest("article") as HTMLElement;
    expect(within(card).getByText("Merged")).toBeVisible();
    expect(within(card).getByRole("link", {
      name: "Open merge request !22 in GitLab",
    })).toHaveAttribute(
      "href",
      "https://gitlab.example.com/acme/api/-/merge_requests/22",
    );
  });

  it("reorders a workspace within its lane", () => {
    const current = reconcileWorkspaceBoardOrder(
      loadWorkspaceBoardOrder({ getItem: () => null }),
      new Map([
        ["ws-a", "planned" as const],
        ["ws-b", "planned" as const],
      ]),
      ["ws-a", "ws-b"],
    );

    expect(
      placeWorkspaceOnBoard(current, {
        workspaceId: "ws-a",
        sourceLane: "planned",
        targetLane: "planned",
        targetWorkspaceId: "ws-b",
        edge: "after",
      }).lanes.planned,
    ).toEqual(["ws-b", "ws-a"]);
  });

  it("places a workspace in an empty lane", () => {
    const current = reconcileWorkspaceBoardOrder(
      loadWorkspaceBoardOrder({ getItem: () => null }),
      new Map([["ws-a", "planned" as const]]),
      ["ws-a"],
    );

    const next = placeWorkspaceOnBoard(current, {
      workspaceId: "ws-a",
      sourceLane: "planned",
      targetLane: "attention",
      targetWorkspaceId: null,
      edge: "after",
    });

    expect(next.lanes.planned).toEqual([]);
    expect(next.lanes.attention).toEqual(["ws-a"]);
    expect(
      workspacePlacementNeighbor({
        workspaceId: "ws-a",
        sourceLane: "planned",
        targetLane: "attention",
        targetWorkspaceId: null,
        edge: "after",
      }),
    ).toEqual({});
  });

  it("maps the insertion rail to one durable neighbor", () => {
    expect(
      workspacePlacementNeighbor({
        workspaceId: "ws-a",
        sourceLane: "planned",
        targetLane: "planned",
        targetWorkspaceId: "ws-b",
        edge: "before",
      }),
    ).toEqual({ beforeWorkspaceId: "ws-b" });
    expect(
      workspacePlacementNeighbor({
        workspaceId: "ws-a",
        sourceLane: "planned",
        targetLane: "planned",
        targetWorkspaceId: "ws-b",
        edge: "after",
      }),
    ).toEqual({ afterWorkspaceId: "ws-b" });
  });

  it("loads a saved order and discards duplicate or stale lane entries", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const saved = placeWorkspaceOnBoard(
      reconcileWorkspaceBoardOrder(
        loadWorkspaceBoardOrder(storage),
        new Map([
          ["ws-a", "planned" as const],
          ["ws-b", "planned" as const],
        ]),
        ["ws-a", "ws-b"],
      ),
      {
        workspaceId: "ws-a",
        sourceLane: "planned",
        targetLane: "planned",
        targetWorkspaceId: "ws-b",
        edge: "after",
      },
    );
    saveWorkspaceBoardOrder(saved, storage);

    expect(loadWorkspaceBoardOrder(storage).lanes.planned).toEqual([
      "ws-b",
      "ws-a",
    ]);
    expect(values.has(WORKSPACE_BOARD_ORDER_STORAGE_KEY)).toBe(true);
  });
});
