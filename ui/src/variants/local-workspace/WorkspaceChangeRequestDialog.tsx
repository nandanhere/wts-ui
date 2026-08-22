import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import type { WorkspaceChangeRequestDraft } from "../../lib/wtsClient";
import { Glyph } from "./Glyph";
import styles from "./WorkspaceChangeRequestDialog.module.css";

export function WorkspaceChangeRequestDialog({
  draft,
  error,
  opening,
  requestingVerification,
  onOpenChange,
  onRequestVerification,
  onSubmit,
}: {
  draft: WorkspaceChangeRequestDraft | null;
  error: string;
  opening: boolean;
  requestingVerification: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestVerification: () => void;
  onSubmit: (title: string, body: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  useEffect(() => {
    setTitle(draft?.title ?? "");
    setBody(draft?.body ?? "");
  }, [draft]);
  const forgeName = draft?.forge === "github" ? "GitHub" : "GitLab";
  const requestName = draft?.forge === "github" ? "pull request" : "merge request";
  const agentName = draft?.proposedByProvider === "codex"
    ? "Codex"
    : draft?.proposedByProvider === "openCode"
      ? "OpenCode"
      : "Hermes";
  const verificationIcon = draft?.verificationStatus === "passed"
    ? "check"
    : draft?.verificationStatus === "notReported"
      ? "issue"
      : "warning";

  return (
    <Dialog.Root open={draft !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.dialog}
          data-ui="workspace.change-request-dialog"
          data-ui-label="Change request preparation"
        >
          <header className={styles.header}>
            <span>
              <small>DELIVERY</small>
              <Dialog.Title>Prepare {requestName} · {draft?.repositoryLabel}</Dialog.Title>
            </span>
            <Dialog.Close aria-label="Close change request preparation" className={styles.iconButton}>
              <Glyph name="close" size={15} />
            </Dialog.Close>
          </header>

          {draft ? (
            <div className={styles.content}>
              <section className={styles.receipt} aria-label="Published branch">
                <span><small>Source</small><b>{draft.sourceRemoteName}/{draft.sourceBranch}</b></span>
                <span><small>Commit</small><code>{draft.sourceHeadCommitOid.slice(0, 8)}</code></span>
                <span><small>Target</small><b>{draft.targetBranch}</b></span>
                <span className={styles.ready}><Glyph name="check" size={12} /> Published</span>
              </section>

              <section className={styles.agentProposal} aria-label="Agent proposal">
                <span><Glyph name="code" size={13} /><b>{agentName} proposal</b></span>
                <small>Validated for this repository and commit</small>
              </section>

              <section className={styles.inventory} aria-label="Complete change inventory">
                <details open>
                  <summary>{draft.commits.length} {draft.commits.length === 1 ? "commit" : "commits"}</summary>
                  <ol>
                    {draft.commits.map((commit) => (
                      <li key={commit.commitOid}>
                        <code>{commit.commitOid.slice(0, 8)}</code>
                        <span>{commit.subject}</span>
                      </li>
                    ))}
                  </ol>
                </details>
                <details>
                  <summary>{draft.changedFiles.length} changed {draft.changedFiles.length === 1 ? "file" : "files"}</summary>
                  <ul>
                    {draft.changedFiles.map((file) => <li key={file}><code>{file}</code></li>)}
                  </ul>
                </details>
              </section>

              {draft.workItems.length > 0 ? (
                <section className={styles.context}>
                  <h3>Issues selected by the agent</h3>
                  {draft.workItems.map((item) => (
                    <p key={item.linkId}><b>{item.issueKey}</b><span>{item.summary}</span></p>
                  ))}
                </section>
              ) : null}

              <label className={styles.field}>
                <span>Title</span>
                <input maxLength={256} onChange={(event) => setTitle(event.currentTarget.value)} value={title} />
              </label>
              <label className={styles.field}>
                <span>Description</span>
                <textarea maxLength={16000} onChange={(event) => setBody(event.currentTarget.value)} rows={13} value={body} />
              </label>
              <p
                className={styles.verification}
                data-status={draft.verificationStatus}
              >
                <Glyph name={verificationIcon} size={12} />
                <b>Agent verification</b>
                <span>{draft.verificationSummary}</span>
                {draft.verificationStatus === "notReported" ? (
                  <button
                    className={styles.verificationButton}
                    disabled={requestingVerification}
                    onClick={onRequestVerification}
                    type="button"
                  >
                    {requestingVerification ? `Starting ${agentName}…` : `Ask ${agentName} to verify`}
                  </button>
                ) : null}
              </p>
              {error ? <p className={styles.error} role="alert">{error}</p> : null}
            </div>
          ) : null}

          <footer className={styles.footer}>
            <Dialog.Description>WTS opens the form. {forgeName} creates the {requestName}.</Dialog.Description>
            <span>
              <Dialog.Close className={styles.secondaryButton}>Cancel</Dialog.Close>
              <button
                className={styles.primaryButton}
                disabled={opening || requestingVerification || !title.trim() || !body.trim()}
                onClick={() => onSubmit(title, body)}
                type="button"
              >
                {opening ? "Opening…" : `Continue in ${forgeName}`}
                <Glyph name="external" size={12} />
              </button>
            </span>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
