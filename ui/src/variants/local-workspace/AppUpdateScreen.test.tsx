import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import {
  fakeWorkspaceClient,
  workspaceListFixture,
} from "../../test/workspaceClientFake";

const updateEvents = vi.hoisted(() => ({
  handler: null as null | ((event: { payload: unknown }) => void),
  unlisten: vi.fn(),
  listen: vi.fn(async (
    _event: string,
    handler: (event: { payload: unknown }) => void,
  ) => {
    updateEvents.handler = handler;
    return updateEvents.unlisten;
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: updateEvents.listen }));

afterEach(() => {
  delete (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
  updateEvents.handler = null;
  updateEvents.listen.mockClear();
  updateEvents.unlisten.mockClear();
});

describe("WTS app updates", () => {
  it("checks and installs an available update automatically at startup", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      appUpdateStatus: {
        schemaVersion: 1,
        state: "available",
        currentVersion: "0.1.0",
        availableVersion: "0.2.0",
        detail: "A signed local update is available.",
      },
    });
    fake.downloadAndInstallUpdate.mockResolvedValue({
      schemaVersion: 1,
      state: "ready",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      detail: "The update is installed. Relaunch WTS to use it.",
    });
    fake.relaunchUpdatedApp.mockResolvedValue({ accepted: true });

    render(<App initialPath="/" workspaceClient={fake.client} />);

    const openSettings = await screen.findByRole(
      "button",
      { name: "Open Environment and integrations" },
      { timeout: 5_000 },
    );
    await waitFor(() => expect(fake.checkForUpdate).toHaveBeenCalledOnce());
    await waitFor(() => expect(fake.downloadAndInstallUpdate).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("button", { name: "Updates" }),
    ).not.toBeInTheDocument();
    await user.click(openSettings);
    await user.click(screen.getByRole("tab", { name: /Updates/ }));
    expect(await screen.findByText("WTS 0.2.0 is ready", {}, { timeout: 5_000 })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Update WTS" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Relaunch WTS" }));
    expect(fake.relaunchUpdatedApp).toHaveBeenCalledOnce();
  });

  it("checks again on focus and installs an update that arrived in the background", async () => {
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      appUpdateStatus: {
        schemaVersion: 1,
        state: "upToDate",
        currentVersion: "0.1.0",
        detail: "WTS is current.",
      },
    });
    fake.checkForUpdate
      .mockResolvedValueOnce({
        schemaVersion: 1,
        state: "upToDate",
        currentVersion: "0.1.0",
        detail: "WTS is current.",
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        state: "available",
        currentVersion: "0.1.0",
        availableVersion: "0.2.0",
        detail: "A signed local update is available.",
      });
    fake.downloadAndInstallUpdate.mockResolvedValue({
      schemaVersion: 1,
      state: "ready",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      detail: "The update is installed. Restart WTS to use it.",
    });

    render(<App initialPath="/" workspaceClient={fake.client} />);
    await waitFor(() => expect(fake.checkForUpdate).toHaveBeenCalledOnce());

    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(fake.checkForUpdate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fake.downloadAndInstallUpdate).toHaveBeenCalledOnce());
  });

  it("shows download progress without exposing an update path", async () => {
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      appUpdateStatus: {
        schemaVersion: 1,
        state: "downloading",
        currentVersion: "0.1.0",
        availableVersion: "0.2.0",
        downloadedBytes: 524_288,
        totalBytes: 1_048_576,
        detail: "WTS downloads and verifies the update.",
      },
    });

    render(<App initialPath="/updates" workspaceClient={fake.client} />);

    expect(await screen.findByRole("progressbar", {
      name: "Update download progress",
    })).toHaveValue(50);
    expect(screen.getByText("512 KiB of 1.0 MiB")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/\/Applications|https?:\/\//);
  });

  it("applies bounded native progress events and removes the listener", async () => {
    (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__ = {};
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      appUpdateStatus: {
        schemaVersion: 1,
        state: "available",
        currentVersion: "0.1.0",
        availableVersion: "0.2.0",
        detail: "A signed local update is available.",
      },
    });
    fake.downloadAndInstallUpdate.mockReturnValue(new Promise(() => {}));

    const rendered = render(
      <App initialPath="/updates" workspaceClient={fake.client} />,
    );
    await waitFor(() => expect(fake.downloadAndInstallUpdate).toHaveBeenCalledOnce());
    await waitFor(() => expect(updateEvents.listen).toHaveBeenCalledWith(
      "wts://update-progress",
      expect.any(Function),
    ));

    act(() => {
      updateEvents.handler?.({
        payload: {
          version: "0.2.0",
          downloadedBytes: 524_288,
          totalBytes: 1_048_576,
        },
      });
    });
    expect(screen.getByRole("progressbar", {
      name: "Update download progress",
    })).toHaveValue(50);
    expect(screen.getByText("512 KiB of 1.0 MiB")).toBeVisible();

    act(() => rendered.unmount());
    expect(updateEvents.unlisten).toHaveBeenCalledOnce();
  });

  it("shows an offline recovery action and accepts a manual retry", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      appUpdateStatus: {
        schemaVersion: 1,
        state: "error",
        currentVersion: "0.1.0",
        detail: "WTS could not reach the configured update channel.",
        diagnosticCode: "networkUnavailable",
      },
    });

    render(<App initialPath="/updates" workspaceClient={fake.client} />);

    expect(await screen.findByRole("heading", { name: "WTS is offline" })).toBeVisible();
    fake.checkForUpdate.mockResolvedValueOnce({
      schemaVersion: 1,
      state: "upToDate",
      currentVersion: "0.1.0",
      detail: "WTS is current.",
    });
    await user.click(
      screen.getByRole("button", { name: "Check for updates" }),
    );
    expect(await screen.findByText("WTS is up to date")).toBeVisible();
    expect(fake.checkForUpdate).toHaveBeenCalledTimes(2);
  });
});
