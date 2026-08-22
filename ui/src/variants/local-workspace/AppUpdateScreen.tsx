import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "react-aria-components";
import {
  normalizeAppUpdateProgress,
  type AppUpdateStatus,
  type WorkspaceClient,
} from "../../lib/wtsClient";
import { Glyph } from "./Glyph";
import styles from "./AppUpdateScreen.module.css";

type UpdateAction = "idle" | "checking" | "installing" | "relaunching";
const AUTO_UPDATE_INTERVAL_MS = 5 * 60 * 1_000;

export interface AppUpdateController {
  action: UpdateAction;
  error: string;
  status: AppUpdateStatus | null;
  check: () => Promise<void>;
  install: () => Promise<void>;
  relaunch: () => Promise<void>;
}

export function useAppUpdate(client: WorkspaceClient): AppUpdateController {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [action, setAction] = useState<UpdateAction>("checking");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const operationActive = useRef(false);
  const statusRef = useRef<AppUpdateStatus | null>(null);

  const applyStatus = useCallback((next: AppUpdateStatus) => {
    statusRef.current = next;
    if (mounted.current) setStatus(next);
  }, []);

  const check = useCallback(async () => {
    if (operationActive.current || statusRef.current?.state === "ready") return;
    operationActive.current = true;
    let checkedStatus: AppUpdateStatus | null = null;
    setAction("checking");
    setError("");
    try {
      const next = await client.checkForUpdate();
      if (!mounted.current) return;
      checkedStatus = next;
      applyStatus(next);
      if (next.state === "available") {
        setAction("installing");
        applyStatus({ ...next, state: "downloading", downloadedBytes: 0 });
        applyStatus(await client.downloadAndInstallUpdate());
      }
    } catch (cause) {
      if (!mounted.current) return;
      if (checkedStatus?.state === "available") applyStatus(checkedStatus);
      setError(
        cause instanceof Error
          ? cause.message
          : "WTS could not check for updates.",
      );
    } finally {
      operationActive.current = false;
      if (mounted.current) setAction("idle");
    }
  }, [applyStatus, client]);

  useEffect(() => {
    mounted.current = true;
    void check();
    return () => {
      mounted.current = false;
    };
  }, [check]);

  useEffect(() => {
    const checkWhenActive = () => void check();
    const interval = window.setInterval(checkWhenActive, AUTO_UPDATE_INTERVAL_MS);
    window.addEventListener("focus", checkWhenActive);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", checkWhenActive);
    };
  }, [check]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in globalThis)) return;
    let active = true;
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const unlisten = await listen<unknown>("wts://update-progress", (event) => {
        if (!active) return;
        try {
          const progress = normalizeAppUpdateProgress(event.payload);
          setStatus((current) =>
            current && current.availableVersion === progress.version
              ? {
                  ...current,
                  state: "downloading",
                  downloadedBytes: progress.downloadedBytes,
                  ...(progress.totalBytes === undefined
                    ? {}
                    : { totalBytes: progress.totalBytes }),
                }
              : current,
          );
        } catch {
          // Ignore an invalid native progress event. The command result remains authoritative.
        }
      });
      if (active) stop = unlisten;
      else unlisten();
    });
    return () => {
      active = false;
      stop?.();
    };
  }, []);

  const install = useCallback(async () => {
    if (operationActive.current) return;
    operationActive.current = true;
    setAction("installing");
    setError("");
    setStatus((current) =>
      current?.availableVersion
        ? { ...current, state: "downloading", downloadedBytes: 0 }
        : current,
    );
    try {
      const next = await client.downloadAndInstallUpdate();
      applyStatus(next);
    } catch (cause) {
      if (!mounted.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "WTS could not install the update.",
      );
    } finally {
      operationActive.current = false;
      if (mounted.current) setAction("idle");
    }
  }, [applyStatus, client]);

  const relaunch = useCallback(async () => {
    setAction("relaunching");
    setError("");
    try {
      const result = await client.relaunchUpdatedApp();
      if (!result.accepted) {
        throw new Error("WTS did not accept the relaunch request.");
      }
    } catch (cause) {
      if (!mounted.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "WTS could not relaunch the app.",
      );
      setAction("idle");
    }
  }, [client]);

  return { action, error, status, check, install, relaunch };
}

function formattedBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

export function AppUpdateScreen({
  controller,
  embedded = false,
}: {
  controller: AppUpdateController;
  embedded?: boolean;
}) {
  const { action, check, error, install, relaunch, status } = controller;
  const checking = action === "checking";
  const installing = action === "installing" || status?.state === "downloading";
  const relaunching = action === "relaunching";
  const progress =
    status?.downloadedBytes !== undefined && status.totalBytes
      ? Math.min(100, Math.round((status.downloadedBytes / status.totalBytes) * 100))
      : null;
  const effectiveError = error || (status?.state === "error" ? status.detail : "");
  const offline = status?.diagnosticCode === "networkUnavailable";

  return (
    <section
      className={`${styles.page} ${embedded ? styles.embedded : ""}`}
      data-ui={embedded ? "environment.updates" : "updates.page"}
      data-ui-label={embedded ? "Update settings" : "App updates page"}
    >
      <header
        className={styles.header}
        data-ui="updates.header"
        data-ui-label="App updates header"
      >
        <span>
          {!embedded && <small>WTS</small>}
          <h1>App updates</h1>
          <p>WTS checks for and installs signed updates automatically.</p>
        </span>
        <Button
          className={styles.secondaryButton}
          isDisabled={checking || installing || relaunching}
          onPress={() => void check()}
        >
          <Glyph name="refresh" size={14} />
          {checking ? "Checking…" : "Check for updates"}
        </Button>
      </header>

      <section
        aria-live="polite"
        className={styles.statusCard}
        data-state={effectiveError ? "error" : status?.state ?? "checking"}
        data-ui="updates.status"
        data-ui-label="Update status"
        role={effectiveError ? "alert" : "status"}
      >
        <span className={styles.statusIcon}>
          <Glyph
            name={
              effectiveError
                ? "warning"
                : status?.state === "upToDate" || status?.state === "ready"
                  ? "check"
                  : "refresh"
            }
            size={20}
          />
        </span>
        <div className={styles.statusCopy}>
          <small>
            {status ? `Installed version ${status.currentVersion}` : "WTS update service"}
          </small>
          <h2>
            {effectiveError
              ? offline
                ? "WTS is offline"
                : "WTS could not update"
              : checking && !status
                ? "WTS checks for updates"
                : status?.state === "disabled"
                  ? "Updates are not available"
                  : status?.state === "upToDate"
                    ? "WTS is up to date"
                    : status?.state === "available"
                      ? `WTS ${status.availableVersion} is available`
                      : status?.state === "downloading"
                        ? `WTS downloads ${status.availableVersion}`
                        : status?.state === "ready"
                          ? `WTS ${status.availableVersion} is ready`
                          : "WTS checks for updates"}
          </h2>
          <p>{effectiveError || status?.detail || "Checking the configured update channel."}</p>
          {status?.notes && status.state === "available" && (
            <p className={styles.notes}>{status.notes}</p>
          )}
          {installing && (
            <div className={styles.progress}>
              <progress
                aria-label="Update download progress"
                max={100}
                value={progress ?? undefined}
              />
              <small>
                {status?.downloadedBytes !== undefined
                  ? `${formattedBytes(status.downloadedBytes)}${status.totalBytes ? ` of ${formattedBytes(status.totalBytes)}` : " downloaded"}`
                  : "WTS downloads and verifies the update."}
              </small>
            </div>
          )}
        </div>
        {(status?.state === "available" || status?.state === "ready") &&
          !effectiveError && (
          <div
            className={styles.actions}
            data-ui="updates.actions"
            data-ui-label="Update actions"
          >
          {status.state === "available" && (
            <Button
              className={styles.primaryButton}
              isDisabled={installing || checking}
              onPress={() => void install()}
            >
              <Glyph name="refresh" size={14} />
              Update WTS
            </Button>
          )}
          {status.state === "ready" && (
            <Button
              className={styles.primaryButton}
              isDisabled={relaunching || checking}
              onPress={() => void relaunch()}
            >
              <Glyph name="refresh" size={14} />
              {relaunching ? "Relaunching…" : "Relaunch WTS"}
            </Button>
          )}
          </div>
        )}
      </section>
    </section>
  );
}
