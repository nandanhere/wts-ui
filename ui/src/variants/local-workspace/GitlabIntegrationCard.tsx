import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  GitlabIntegrationStatus,
  WorkspaceClient,
} from "../../lib/wtsClient";
import { Glyph } from "./Glyph";
import styles from "./SetupSheet.module.css";

type LoadState = "idle" | "loading" | "ready" | "error";

function accountLabel(state: "signedIn" | "signedOut" | "error") {
  if (state === "signedIn") return "Ready";
  if (state === "error") return "Check failed";
  return "CLI not configured";
}

export function GitlabIntegrationCard({
  client,
  workspaceId,
}: {
  client: WorkspaceClient;
  workspaceId?: string;
}) {
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [status, setStatus] = useState<GitlabIntegrationStatus | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!workspaceId) {
      setStatus(null);
      setLoadState("idle");
      setError("");
      return;
    }
    setLoadState("loading");
    setError("");
    try {
      const result = await client.getGitlabIntegrationStatus(workspaceId);
      setStatus(result);
      setLoadState("ready");
    } catch (cause) {
      setLoadState("error");
      setError(
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : "WTS could not check the GitLab connection.",
      );
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const signedInCount = useMemo(
    () => status?.accounts.filter((account) => account.state === "signedIn").length ?? 0,
    [status],
  );
  const hasAccountError = status?.accounts.some(
    (account) => account.state === "error",
  ) ?? false;
  const tone = !workspaceId
    ? "unchecked"
    : loadState === "loading"
      ? "checking"
      : loadState === "error"
        ? "failed"
        : status?.cliState === "missing"
          ? "unavailable"
          : hasAccountError
            ? "failed"
            : status?.accounts.length && signedInCount === status.accounts.length
            ? "verified"
            : "auth";
  const statusLabel = !workspaceId
    ? "No workspace"
    : loadState === "loading"
      ? "WTS checks"
      : loadState === "error"
        ? "Check failed"
        : status?.cliState === "missing"
          ? "CLI required"
          : hasAccountError
            ? "Check failed"
            : status?.accounts.length && signedInCount === status.accounts.length
            ? "Connected"
            : status?.accounts.length
              ? "CLI not configured"
              : "No GitLab host";

  return (
    <li
      className={styles.integrationRow}
      data-ui="environment.gitlab"
      data-ui-label="GitLab integration"
    >
      <div className={styles.integrationLead}>
        <span className={styles.gitlabMark} aria-hidden="true">GL</span>
        <span className={styles.integrationIdentity}>
          <span><b>GitLab</b></span>
          <small>Merge request tracking and trusted handoffs</small>
        </span>
        <span className={styles.statusBadge} data-tone={tone}>
          <i />
          {statusLabel}
        </span>
      </div>

      <div className={styles.integrationOutcome} aria-live="polite">
        {!workspaceId ? (
          <small>Open a workspace that has a GitLab repository.</small>
        ) : loadState === "error" ? (
          <>
            <span><Glyph name="warning" size={13} />Connection check failed</span>
            <small>{error}</small>
            <button className={styles.adapterVerifyButton} onClick={() => void load()} type="button">
              Try again
            </button>
          </>
        ) : status?.cliState === "missing" ? (
          <>
            <span><Glyph name="warning" size={13} />GitLab CLI is required</span>
            <small>Install and configure <code>glab</code> in Terminal. WTS uses the existing CLI account.</small>
            <button className={styles.adapterVerifyButton} onClick={() => void load()} type="button">
              Check again
            </button>
          </>
        ) : status && status.accounts.length === 0 ? (
          <>
            <span><Glyph name="check" size={13} />No GitLab host in this workspace</span>
            <small>WTS checks hosts from trusted workspace repositories.</small>
          </>
        ) : (
          <>
            {status?.detail && <small>{status.detail}</small>}
            <ul
              aria-label="GitLab accounts"
              className={styles.gitlabAccounts}
              data-ui="environment.gitlab.accounts"
              data-ui-label="GitLab accounts"
            >
              {status?.accounts.map((account) => (
                <li key={account.host}>
                  <span>
                    <b>{account.host}</b>
                    <small>
                      {account.state === "signedIn" && account.username
                        ? `Signed in as ${account.username}`
                        : accountLabel(account.state)}
                    </small>
                  </span>
                  {account.state === "signedIn" ? (
                    <span className={styles.gitlabConnected}>
                      <Glyph name="check" size={13} /> Ready
                    </span>
                  ) : (
                    <small>
                      Configure <code>glab</code> for this host in Terminal.
                    </small>
                  )}
                </li>
              ))}
            </ul>
            <button
              className={styles.adapterVerifyButton}
              disabled={loadState === "loading"}
              onClick={() => void load()}
              type="button"
            >
              {loadState === "loading" ? "WTS checks…" : "Check connection"}
            </button>
          </>
        )}
      </div>
    </li>
  );
}
