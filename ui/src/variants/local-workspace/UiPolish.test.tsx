import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  fakeWorkspaceClient,
  workspaceFixture,
  workspaceListFixture,
} from "../../test/workspaceClientFake";
import { LocalWorkspace } from "./LocalWorkspace";
import { RepositoryReviewScreen } from "./RepositoryReviewScreen";

const workspaceCss = readFileSync(
  resolve(__dirname, "./LocalWorkspace.module.css"),
  "utf8",
);

function extractHexColors(css: string): string[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return noComments.match(/#(?:[0-9a-fA-F]{3,4}){1,2}\b/g) ?? [];
}

describe("UI Polish & Perceived Quality", () => {
  describe("Loading Skeletons", () => {
    it("renders board loading skeleton alongside recovery status when workspaces are loading", () => {
      const fake = fakeWorkspaceClient({
        list: new Promise<never>(() => {}) as unknown as any, // Never resolves
      });

      render(<LocalWorkspace client={fake.client} />);

      expect(screen.getByTestId("board-skeleton")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Opening the local registry" }),
      ).toBeInTheDocument();
    });
  });

  describe("Empty States & STE Copy", () => {
    it("renders helpful empty state guidance and single New workspace button on an empty board", async () => {
      const fake = fakeWorkspaceClient({
        list: workspaceListFixture([]),
      });

      render(<LocalWorkspace client={fake.client} />);

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "No local workspaces found" }),
        ).toBeInTheDocument();
      });

      expect(
        screen.getByText(
          "Create the first local plan to isolate changes, review diffs, and manage worktrees.",
        ),
      ).toBeInTheDocument();

      const newWorkspaceButtons = screen.getAllByRole("button", {
        name: /New workspace/i,
      });
      expect(newWorkspaceButtons).toHaveLength(1);
    });

    it("renders search empty state with clear filters action when filter matches nothing", async () => {
      const user = userEvent.setup();
      const ws1 = workspaceFixture({ workspaceId: "ws_01", title: "First Plan" });
      const fake = fakeWorkspaceClient({
        list: workspaceListFixture([ws1]),
      });

      render(<LocalWorkspace client={fake.client} />);

      await waitFor(() => {
        expect(screen.getByText("First Plan")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText(/search/i);
      await user.type(searchInput, "nonexistent_query_xyz");

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "No matching workspaces found" }),
        ).toBeInTheDocument();
      });

      expect(
        screen.getByText("Clear search term or filter to show local workspaces."),
      ).toBeInTheDocument();

      const clearBtn = screen.getByRole("button", { name: "Clear filters" });
      expect(clearBtn).toBeInTheDocument();

      await user.click(clearBtn);
      await waitFor(() => {
        expect(screen.getByText("First Plan")).toBeInTheDocument();
      });
    });

    it("renders empty changes state in RepositoryReviewScreen", async () => {
      const mockMaterialization = {
        schemaVersion: 1 as const,
        workspaceId: "ws_01",
        workspaceRecordVersion: 1,
        effectDigest: "sha256:123",
        workspaceDisplayPath: "/tmp/ws_01",
        codeWorkspaceDisplayPath: "/tmp/ws_01/wts.code-workspace",
        branchName: "wts/ws_01",
        worktrees: [
          {
            repositoryId: "repo_1",
            label: "repo_1",
            targetDisplayPath: "/tmp/ws_01/repo_1",
            branchName: "wts/ws_01",
            baseCommitOid: "123456",
          },
        ],
        graph: { status: "ready" as const, nodeCount: 0, edgeCount: 0, detail: "0 nodes" },
      };

      const fake = fakeWorkspaceClient({
        list: workspaceListFixture([]),
        repositoryDiff: {
          schemaVersion: 1,
          workspaceId: "ws_01",
          repositoryId: "repo_1",
          repositoryLabel: "repo_1",
          baseCommitOid: "1234567890abcdef",
          headCommitOid: "1234567890abcdef",
          patchSha256: `sha256:${"a".repeat(64)}`,
          patch: "",
          patchTruncated: false,
          untrackedPaths: [],
          untrackedPathsTruncated: false,
          reviewGraph: undefined,
        },
      });

      render(
        <RepositoryReviewScreen
          client={fake.client}
          initialRepositoryId="repo_1"
          materialization={mockMaterialization}
          onRepositoryChange={() => {}}
          workspaceId="ws_01"
        />,
      );

      expect(await screen.findByText("No local changes")).toBeInTheDocument();
      expect(
        screen.getByText("The workspace is up to date with the target branch."),
      ).toBeInTheDocument();
    });
  });

  describe("Styles & Motion Contract", () => {
    it("contains no hardcoded hex colors in LocalWorkspace.module.css", () => {
      const hexes = extractHexColors(workspaceCss);
      expect(hexes).toEqual([]);
    });

    it("defines skeleton classes and respects prefers-reduced-motion", () => {
      expect(workspaceCss).toContain(".boardSkeleton");
      expect(workspaceCss).toContain(".skeletonCard");
      expect(workspaceCss).toContain(".workbenchSkeleton");
      expect(workspaceCss).toContain("prefers-reduced-motion: reduce");
      expect(workspaceCss).toContain("var(--wts-focus-ring)");
    });
  });
});
