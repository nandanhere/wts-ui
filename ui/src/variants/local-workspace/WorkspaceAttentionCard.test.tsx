import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceAttentionCard } from "./WorkspaceAttentionCard";
import type { WorkspaceAttentionItem } from "./workspaceAttention";

const now = Date.now();
const results: WorkspaceAttentionItem[] = ["Workspace repositories", "Conversation list", "Changed code", "Changed code", "Changed code", "Workspace repositories", "Workspace repositories"]
  .map((label, index) => ({
    id: "agent-" + index, revision: "r" + index, workspaceId: "space", kind: "agent", label,
    detail: "Agent result awaits review.", occurredAt: now - (index + 1) * 60 * 60_000, count: 1,
    target: { kind: "agent", conversationId: "c" + index, requestId: "q" + index, messageId: "m" + index, repositoryId: "repo" },
  }));

describe("workspace attention card", () => {
  it("shows agent results as short rows and keeps the rest behind Show more", () => {
    const onOpen = vi.fn(); const onAcknowledge = vi.fn();
    render(<WorkspaceAttentionCard workspaceId="space" workspaceLabel="wts-ui" items={results} history={[]} onOpen={onOpen} onAcknowledge={onAcknowledge} />);
    const card = screen.getByRole("region", { name: "wts-ui attention" });
    const rows = () => within(card).getAllByRole("button", { name: /Agent result awaits review\.$/ });

    expect(rows()).toHaveLength(3);
    expect(within(card).getByText("1h")).toBeVisible();
    expect(within(card).queryByText("Reviewed")).not.toBeInTheDocument();
    expect(within(card).getAllByRole("button", { name: /^Mark .* as reviewed$/ })).toHaveLength(3);

    fireEvent.click(within(card).getByRole("button", { name: "Show 4 more" }));
    expect(rows()).toHaveLength(7);
    fireEvent.click(rows()[6]!);
    expect(onOpen).toHaveBeenCalledWith(results[6]);
    fireEvent.click(within(card).getAllByRole("button", { name: "Mark Workspace repositories as reviewed" })[2]!);
    expect(onAcknowledge).toHaveBeenCalledWith(results[6]);

    fireEvent.click(within(card).getByRole("button", { name: "Show fewer" }));
    expect(rows()).toHaveLength(3);
  });
});
