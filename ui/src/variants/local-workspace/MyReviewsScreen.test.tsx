import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import type { GithubReviewInbox, WorkspaceClient } from "../../lib/wtsClient";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import {
  REVIEW_INBOX_POLL_INTERVAL_MS,
  useGithubReviewInbox,
  MyReviewsScreen,
} from "./MyReviewsScreen";

const reviewInbox: GithubReviewInbox = {
  schemaVersion: 1,
  state: "fresh",
  reviews: [
    {
      id: "PR_kwDO-review-42",
      repositoryId: "repo_checkout",
      repository: "acme/checkout-api",
      number: 42,
      title: "Keep retry keys stable",
      url: "https://github.com/acme/checkout-api/pull/42",
      authorLogin: "octocat",
      updatedAt: "2026-08-14T08:15:00Z",
      draft: false,
    },
  ],
  fetchedAtUnixMs: 1_776_153_300_000,
  detail: "GitHub returned the current individual review requests.",
};

function InboxHarness({ client, onOpenIntegrations = () => {} }: { client: WorkspaceClient; onOpenIntegrations?: () => void }) {
  const { refresh, ...inbox } = useGithubReviewInbox(client);
  return <MyReviewsScreen client={client} {...inbox} onRefresh={refresh} onOpenIntegrations={onOpenIntegrations} />;
}

describe("My reviews", () => {
  it("shows the failed provider when only one inbox request fails", async () => {
    const fake = fakeWorkspaceClient();
    fake.getGithubReviewInbox.mockRejectedValueOnce(new Error("GitHub connection failed."));
    render(<InboxHarness client={fake.client} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("GitHub connection failed.");
    expect(screen.queryByText("GitHub and GitLab found no review requests or approved merge requests.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh GitHub reviews" }));
    await waitFor(() => expect(fake.getGithubReviewInbox).toHaveBeenCalledTimes(2));
  });

  it.each(["GitHub", "GitLab"])("offers a connection route for %s while the other provider is ready", async (provider) => {
    const fake = fakeWorkspaceClient();
    const auth = { schemaVersion: 1 as const, state: "auth" as const, reviews: [], fetchedAtUnixMs: null, detail: `${provider} requires authentication.`, diagnosticCode: "authenticationRequired" as const };
    if (provider === "GitHub") fake.getGithubReviewInbox.mockResolvedValue(auth);
    else fake.getGitlabReviewInbox.mockResolvedValue(auth);
    const onOpenIntegrations = vi.fn();
    render(<InboxHarness client={fake.client} onOpenIntegrations={onOpenIntegrations} />);
    fireEvent.click(await screen.findByRole("button", { name: `Connect ${provider}` }));
    expect(onOpenIntegrations).toHaveBeenCalledOnce();
    expect(screen.queryByRole("heading", { name: "No reviews to track" })).not.toBeInTheDocument();
  });

  it("retains saved reviews and shows a failed background provider read", async () => {
    const fake = fakeWorkspaceClient();
    fake.getGithubReviewInbox.mockResolvedValueOnce(reviewInbox).mockRejectedValue(new Error("GitHub timed out."));
    render(<InboxHarness client={fake.client} />);
    await screen.findByRole("heading", { name: "Keep retry keys stable" });
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText("GitHub timed out.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Keep retry keys stable" })).toBeVisible();
    expect(screen.getByText("Saved")).toBeVisible();
  });

  it("refreshes assigned reviews in the background and when WTS regains focus", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeWorkspaceClient();
      fake.getGithubReviewInbox
        .mockResolvedValueOnce({
          schemaVersion: 1,
          state: "fresh",
          reviews: [],
          fetchedAtUnixMs: 1_776_153_200_000,
          detail: "GitHub returned no individual review requests.",
        })
        .mockResolvedValue(reviewInbox);

      const { result } = renderHook(() => useGithubReviewInbox(fake.client));

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(fake.getGithubReviewInbox).toHaveBeenCalledTimes(1);
      expect(fake.getGitlabReviewInbox).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(REVIEW_INBOX_POLL_INTERVAL_MS);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(fake.getGithubReviewInbox).toHaveBeenCalledTimes(2);
      expect(fake.getGitlabReviewInbox).toHaveBeenCalledTimes(2);
      expect(result.current.inbox?.reviews[0]?.title).toBe(
        "Keep retry keys stable",
      );

      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(fake.getGithubReviewInbox).toHaveBeenCalledTimes(3);
      expect(fake.getGitlabReviewInbox).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a loading state, assigned count, and trusted Review action", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    let resolveInbox!: (value: GithubReviewInbox) => void;
    fake.getGithubReviewInbox.mockReturnValue(
      new Promise((resolve) => {
        resolveInbox = resolve;
      }),
    );
    fake.openGithubReview.mockResolvedValue({
      repositoryId: "repo_checkout",
      number: 42,
      accepted: true,
    });

    render(<App initialPath="/" workspaceClient={fake.client} />);

    expect(await screen.findByRole(
      "heading",
      { name: "Spaces" },
      { timeout: 5_000 },
    )).toBeVisible();
    await user.click(screen.getByRole("button", { name: "My reviews" }));
    expect(await screen.findByRole(
      "heading",
      { name: "WTS loads your reviews" },
      { timeout: 5_000 },
    )).toBeVisible();
    resolveInbox(reviewInbox);

    expect(await screen.findByRole("heading", { name: "Keep retry keys stable" })).toBeVisible();
    expect(screen.getByLabelText("1 assigned reviews")).toBeVisible();
    expect(screen.queryByRole("link", { name: /Keep retry keys stable/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(fake.openGithubReview).toHaveBeenCalledWith("repo_checkout", 42);
  });

  it("includes GitLab review requests and opens them through the trusted action", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({
      gitlabReviewInbox: {
        schemaVersion: 1,
        state: "fresh",
        reviews: [{
          id: "gid://gitlab/MergeRequest/73",
          repositoryId: "repo_senzu",
          repository: "acme/senzu",
          number: 73,
          title: "Keep workspace removal recoverable",
          authorLogin: "nandan",
          sourceBranch: "feat/removal",
          targetBranch: "develop",
          updatedAt: "2026-08-17T08:15:00Z",
          draft: false,
          reviewState: "requested",
          status: "open",
        }],
        fetchedAtUnixMs: 1_776_412_500_000,
        detail: "GitLab returned the current individual review requests.",
      },
    });
    fake.openGitlabMergeRequest.mockResolvedValue({
      repositoryId: "repo_senzu",
      iid: 73,
      accepted: true,
    });

    render(<App initialPath="/reviews" workspaceClient={fake.client} />);

    expect(await screen.findByRole(
      "heading",
      { name: "Keep workspace removal recoverable" },
      { timeout: 5_000 },
    )).toBeVisible();
    expect(screen.getByText("GL")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(fake.openGitlabMergeRequest).toHaveBeenCalledWith("repo_senzu", 73);
  });

  it("keeps an approved GitLab merge request visible with its lifecycle state", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({
      gitlabReviewInbox: {
        schemaVersion: 1,
        state: "fresh",
        reviews: [{
          id: "887185",
          repositoryId: "repo_obx_api",
          repository: "sre-tools/obx-api",
          number: 9,
          title: "Validate the LogQL time range",
          authorLogin: "priya",
          sourceBranch: "SRETOOLS-6349",
          targetBranch: "develop",
          updatedAt: "2026-08-18T05:05:48Z",
          draft: false,
          reviewState: "approved",
          status: "open",
        }],
        fetchedAtUnixMs: 1_787_029_200_000,
        detail: "GitLab returned current review requests and approved merge requests.",
      },
    });
    fake.openGitlabMergeRequest.mockResolvedValue({
      repositoryId: "repo_obx_api",
      iid: 9,
      accepted: true,
    });

    render(<App initialPath="/reviews" workspaceClient={fake.client} />);

    expect(await screen.findByText("Approved")).toBeVisible();
    expect(screen.getByText("0 pending · 1 approved")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open MR" }));
    expect(fake.openGitlabMergeRequest).toHaveBeenCalledWith("repo_obx_api", 9);
  });

  it("shows the empty and authentication-required states", async () => {
    const empty = fakeWorkspaceClient();
    const emptyRender = render(<App initialPath="/reviews" workspaceClient={empty.client} />);
    expect(await screen.findByRole("heading", { name: "No reviews to track" })).toBeVisible();
    emptyRender.unmount();

    const auth = fakeWorkspaceClient({
      githubReviewInbox: {
        schemaVersion: 1,
        state: "auth",
        reviews: [],
        fetchedAtUnixMs: null,
        detail: "GitHub authentication is required.",
        diagnosticCode: "authenticationRequired",
      },
      gitlabReviewInbox: {
        schemaVersion: 1,
        state: "auth",
        reviews: [],
        fetchedAtUnixMs: null,
        detail: "GitLab authentication is required.",
        diagnosticCode: "authenticationRequired",
      },
    });
    render(<App initialPath="/reviews" workspaceClient={auth.client} />);
    expect(await screen.findByRole("heading", { name: "Connect GitHub and GitLab" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open integrations" })).toBeVisible();
  });

  it("shows saved data with a partial provider failure", async () => {
    const fake = fakeWorkspaceClient({
      githubReviewInbox: {
        ...reviewInbox,
        state: "stale",
        detail: "GitHub is unavailable. WTS shows the last successful review list.",
        diagnosticCode: "providerTimedOut",
      },
    });

    render(<App initialPath="/reviews" workspaceClient={fake.client} />);

    expect(await screen.findByText("WTS shows saved review data.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Keep retry keys stable" })).toBeVisible();
    expect(screen.getByText("Saved")).toBeVisible();
  });

  it("refreshes after a provider error", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    fake.getGithubReviewInbox
      .mockResolvedValueOnce({
        schemaVersion: 1,
        state: "error",
        reviews: [],
        fetchedAtUnixMs: null,
        detail: "GitHub did not return a valid response.",
        diagnosticCode: "providerResponseInvalid",
      })
      .mockResolvedValueOnce(reviewInbox);
    fake.getGitlabReviewInbox.mockResolvedValue({
      schemaVersion: 1,
      state: "error",
      reviews: [],
      fetchedAtUnixMs: null,
      detail: "GitLab did not return a valid response.",
      diagnosticCode: "providerResponseInvalid",
    });

    render(<App initialPath="/reviews" workspaceClient={fake.client} />);

    expect(await screen.findByRole("heading", { name: "Review providers are unavailable" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Keep retry keys stable" })).toBeVisible();
    expect(fake.getGithubReviewInbox).toHaveBeenCalledTimes(2);
  });
});
