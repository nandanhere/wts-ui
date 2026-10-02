import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceRemovalPreflight } from "../../lib/wtsClient";
import type { Workspace } from "./LocalWorkspace";
import { WorkspaceRemovalDialog } from "./WorkspaceRemovalDialog";

const workspace = { id: "ws-one", key: "Local repositories · api" } as Workspace;
const preflight = (): WorkspaceRemovalPreflight => ({ workspaceId: workspace.id, workspaceDisplayPath: "/tmp/workspace", kind: "materializedWorkspace", ready: false, effectDigest: `sha256:${"a".repeat(64)}`, worktrees: [], generatedPaths: [], protectedPaths: [], retainedBranches: ["main"], warnings: [], blockers: [{ code: "workspaceDrift", repositoryLabel: "api", message: "The branch changed.", displayPath: "/tmp/workspace/api", expected: "main", observed: "feature", recoverySteps: ["Register the expected Git changes, then check again."] }] });

function fixture(value = preflight()) {
  const props = { open: true, onOpenChange: vi.fn(), workspace, preflight: value, state: "ready" as const, error: "", onRetry: vi.fn(), onConfirm: vi.fn(), onRegisterChanges: vi.fn(), onReviewChanges: vi.fn(), onOpenPlans: vi.fn(), onOpenIntegrations: vi.fn() };
  return props;
}

describe("Removal recovery", () => {
  it("shows exact facts and gives a real repair action without authorizing deletion", () => {
    const props = fixture();
    render(<WorkspaceRemovalDialog {...props} />);
    expect(screen.getByText("/tmp/workspace/api")).toBeVisible();
    expect(screen.getByText("Expected")).toBeVisible();
    expect(screen.getByText("main")).toBeVisible();
    expect(screen.getByText("feature")).toBeVisible();
    expect(screen.getByText("Register the expected Git changes, then check again.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Register changes & re-index" }));
    expect(props.onRegisterChanges).toHaveBeenCalledOnce();
    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove workspace" })).toBeDisabled();
  });

  it("copies the exact blocked path and keeps a manual fallback when clipboard access fails", async () => {
    const copy = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    render(<WorkspaceRemovalDialog {...fixture()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy path for api" }));
    expect(await screen.findByRole("textbox", { name: "Copy path for api manually" })).toHaveValue("/tmp/workspace/api");
    expect(screen.getByRole("textbox", { name: "Copy path for api manually" })).toHaveFocus();
    expect(copy).toHaveBeenCalledExactlyOnceWith("/tmp/workspace/api");
    expect(screen.queryByText("Copied.")).not.toBeInTheDocument();
  });

  it.each([
    ["worktreeChanges", "Review changes", "onReviewChanges"],
    ["planningDocumentsPresent", "Open Plans", "onOpenPlans"],
    ["gitUnavailable", "Open integrations", "onOpenIntegrations"],
  ] as const)("routes %s to the relevant recovery flow", (code, label, callback) => {
    const value = preflight();
    value.blockers = [{ code, message: "Resolve this condition before removal." }];
    const props = fixture(value);
    render(<WorkspaceRemovalDialog {...props} />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(props[callback]).toHaveBeenCalledOnce();
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("gives older servers concrete guidance for unknown paths and copies a recovery report", async () => {
    const value = preflight();
    value.blockers = [{ code: "unexpectedPath", message: "The workspace contains an unknown path." }];
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    render(<WorkspaceRemovalDialog {...fixture(value)} />);
    expect(screen.getByText("Move files you want to keep outside the workspace.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Copy recovery details" }));
    await screen.findByText("Copied.");
    expect(copy).toHaveBeenCalledWith(expect.stringContaining("/tmp/workspace"));
    expect(copy).toHaveBeenCalledWith(expect.stringContaining("The workspace contains an unknown path."));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});
