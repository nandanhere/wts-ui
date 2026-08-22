import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  fakeWorkspaceClient,
  workspaceFixture,
  workspaceListFixture,
} from "../../test/workspaceClientFake";
import { LocalWorkspace } from "./LocalWorkspace";

describe("LocalWorkspace Accessibility and Consistency Improvements", () => {
  describe("CHANGE A: Replace native title attributes with accessible tooltips", () => {
    it("has zero native title attributes in the rendered DOM", async () => {
      const ws = workspaceFixture({ workspaceId: "ws_01", title: "Accessibility Plan" });
      const list = workspaceListFixture([ws]);
      const fake = fakeWorkspaceClient({ list });

      const { container } = render(<LocalWorkspace client={fake.client} />);

      await waitFor(() => {
        expect(screen.getByText("Accessibility Plan")).toBeInTheDocument();
      });

      // Assert no element in the rendered DOM carries a non-empty native title attribute
      const elementsWithTitle = Array.from(
        container.querySelectorAll("[title]"),
      ).filter((el) => (el.getAttribute("title") ?? "").trim() !== "");
      expect(elementsWithTitle.length).toBe(0);
    });

    it("shows styled tooltip on hover or keyboard focus of former title elements", async () => {
      const user = userEvent.setup();
      const ws = workspaceFixture({
        workspaceId: "ws_01",
        title: "Tooltip Plan",
        observedWorkItems: [
          {
            issueKey: "OTHER-100",
            sourceFiles: ["src/main.rs"],
            observedAtUnixMs: 12345,
          },
        ],
      });
      const list = workspaceListFixture([ws]);
      const fake = fakeWorkspaceClient({ list });

      render(<LocalWorkspace client={fake.client} />);

      await waitFor(() => {
        expect(screen.getByText("Tooltip Plan")).toBeInTheDocument();
      });

      const jiraBadge = screen.getByText("Jira OTHER-100");
      await user.hover(jiraBadge);

      await waitFor(() => {
        expect(screen.getByText("Observed in src/main.rs")).toBeInTheDocument();
      });
    });
  });

  describe("CHANGE B: Workflow stages stay visible", () => {
    it("shows each stage with useful empty guidance", async () => {
      const ws1 = workspaceFixture({ workspaceId: "ws_01", title: "Lane Plan 1" });
      const ws2 = {
        ...workspaceFixture({
          workspaceId: "ws_02",
          title: "Lane Plan 2",
          lifecycle: { materializationState: "materialized", worktreeCount: 1, observedAtUnixMs: 123 },
          workflow: {
            state: "parked",
            revision: 2,
            updatedAtUnixMs: 123,
          },
        }),
      };
      const list = workspaceListFixture([ws1, ws2]);
      const agentSessions = {
        schemaVersion: 1 as const,
        sessions: [],
        observedSessions: [
          {
            schemaVersion: 1 as const,
            sessionId: "33333333-3333-4333-8333-333333333333",
            workspaceId: "ws_01",
            provider: "codex" as const,
            source: "codexVscodeRollout" as const,
            status: "working" as const,
            activity: "runningCommand" as const,
            latestUpdate: "Working...",
            updateKind: "progress" as const,
            startedAtUnixMs: 1000,
            lastEventAtUnixMs: 1000,
          },
        ],
      };
      const fake = fakeWorkspaceClient({ list, agentSessions });

      render(<LocalWorkspace client={fake.client} />);

      await waitFor(() => {
        expect(screen.getByText("Lane Plan 1")).toBeInTheDocument();
        expect(screen.getByText("Lane Plan 2")).toBeInTheDocument();
      });

      expect(screen.getByRole("heading", { name: "Ready" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Active" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Review" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Parked" })).toBeInTheDocument();
      expect(
        screen.getByText("Agent work appears here while it is active."),
      ).toBeVisible();
      expect(
        screen.getByText("Finished work and decisions appear here."),
      ).toBeVisible();
      expect(screen.queryByText(/Reserved for a future/)).not.toBeInTheDocument();
    });
  });

  describe("CHANGE C: Button primitive consistency", () => {
    it("uses the WTS brand as the Spaces control and opens My time from the board", async () => {
      const user = userEvent.setup();
      const ws = workspaceFixture({ workspaceId: "ws_01", title: "Nav Plan" });
      const list = workspaceListFixture([ws]);
      const fake = fakeWorkspaceClient({ list });

      render(<LocalWorkspace client={fake.client} />);

      await waitFor(() => {
        expect(screen.getByText("Nav Plan")).toBeInTheDocument();
      });

      const spacesButton = screen.getByRole("button", { name: "Open Spaces" });
      expect(spacesButton).toBeInTheDocument();

      // react-aria-components Button renders data-rac and data-react-aria-pressable attributes
      expect(spacesButton).toHaveAttribute("data-rac");
      expect(spacesButton).toHaveAttribute("data-react-aria-pressable");
      expect(
        screen.queryByRole("navigation", { name: "WTS sections" }),
      ).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "My time" }));
      expect(
        await screen.findByRole("heading", { name: "Work activity" }),
      ).toBeVisible();
      await user.click(spacesButton);
      expect(
        await screen.findByRole("heading", { name: "Spaces" }),
      ).toBeVisible();
      expect(spacesButton).toHaveAttribute("aria-current", "page");
    });
  });
});
