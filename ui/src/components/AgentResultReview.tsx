import { AgentResultPreview } from "./AgentResultPreview";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { AgentConversation } from "../lib/agentConversations";
import type { AgentTurnChanges } from "../lib/agentTurnChanges";
import { WorkspaceClientError, type WorkspaceClient } from "../lib/wtsClient";
import { useTheme } from "../theme";
import { AgentResultActions } from "./AgentResultActions";
import styles from "./AgentResultReview.module.css";

const RepositoryPatchViewer = lazy(() => import("../variants/local-workspace/RepositoryPatchViewer").then(module => ({ default: module.RepositoryPatchViewer })));

export function AgentResultReview({ client, conversation, requestId, sessionId, onReturnToSelection, onCloseFeedback, resultTitle, calloutScope }: {
  resultTitle?: string;
  calloutScope?: { id: string; label: string };
  client: WorkspaceClient;
  conversation: AgentConversation;
  requestId: string;
  sessionId?: string;
  onReturnToSelection?: () => void;
  onCloseFeedback?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [recorded, setRecorded] = useState<{ value: AgentTurnChanges; client: WorkspaceClient; key: string }>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const { resolvedTheme } = useTheme();
  const { conversationId, workspaceId, repositoryId } = conversation;
  const scopeKey = JSON.stringify([conversationId, requestId, workspaceId, repositoryId, sessionId]);
  const scope = useRef({ client, key: scopeKey });
  if (scope.current.client !== client || scope.current.key !== scopeKey) {
    scope.current = { client, key: scopeKey };
    generation.current += 1;
  }
  const receipt = recorded?.client === client && recorded.key === scopeKey ? recorded.value : undefined;
  const load = useCallback(async () => {
    const request = ++generation.current;
    if (!client.getAgentTurnChanges) {
      setError("This WTS host cannot show task change records. Update WTS, or open the current local changes.");
      setPending(false);
      return;
    }
    setPending(true); setError("");
    try {
      const result = await client.getAgentTurnChanges(conversationId, requestId);
      if (request !== generation.current) return;
      if (result.conversationId !== conversationId || result.requestId !== requestId || result.workspaceId !== workspaceId || result.repositoryId !== repositoryId || (sessionId && result.sessionId !== sessionId)) {
        throw new Error("The task change record does not match this result.");
      }
      setRecorded({ value: result, client, key: scopeKey });
    } catch (cause) {
      if (request !== generation.current) return;
      setError(cause instanceof WorkspaceClientError ? cause.message : cause instanceof Error ? cause.message : "WTS could not read the task change record. Select Retry record.");
    } finally {
      if (request === generation.current) setPending(false);
    }
  }, [client, conversationId, requestId, workspaceId, repositoryId, sessionId, scopeKey]);
  useEffect(() => {
    setRecorded(undefined); setError("");
    if (open) void load();
    return () => { generation.current += 1; };
  }, [open, load]);
  const currentChanges = `/sessions/${encodeURIComponent(workspaceId)}/changes?repository=${encodeURIComponent(repositoryId)}`;
  let previewReturnsToSelection = false;
  try { previewReturnsToSelection = !!onReturnToSelection && conversation.source.kind === "ui" && !!conversation.preview && new URL(conversation.preview.url, window.location.href).origin === window.location.origin; } catch { /* The preview component rejects invalid URLs. */ }
  const openCurrentChanges = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); setOpen(false); onCloseFeedback?.();
    window.dispatchEvent(new CustomEvent("wts:open-agent-workspace", { detail: { workspaceId, repositoryId } }));
  };
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger className={styles.trigger}>Review changes</Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className={styles.overlay} />
      <Dialog.Content className={styles.dialog} data-ui={calloutScope ? `${calloutScope.id}.dialog` : "agent-result.dialog"} data-ui-label={calloutScope ? `${calloutScope.label} changes dialog` : "Task changes dialog"} onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}>
        <header className={styles.header}>
          <div><Dialog.Title>{resultTitle ? `${resultTitle} changes` : "Task changes"}</Dialog.Title><Dialog.Description>File changes observed by WTS during this task.</Dialog.Description></div>
          <Dialog.Close aria-label="Close task changes">Close</Dialog.Close>
        </header>
        <div className={styles.body}>
          <div className={styles.summary} data-ui={calloutScope ? `${calloutScope.id}.summary` : "agent-result.summary"} data-ui-label={calloutScope ? `${calloutScope.label} change summary` : "Task change summary"}>
            {!receipt && <p>Checks are separate from the file change record.</p>}
            <div className={styles.actions}>
              <a href={currentChanges} onClick={openCurrentChanges}>View current local changes</a>
              {!previewReturnsToSelection && <AgentResultPreview conversation={conversation} />}
              {onReturnToSelection && <button onClick={() => { setOpen(false); onReturnToSelection(); }} type="button">Return to selection</button>}
              {client.getAgentTurnChanges && <button disabled={pending} onClick={() => void load()} type="button">{error ? "Retry record" : "Refresh record"}</button>}
            </div>
            {pending && <p role="status">WTS reads the task change record.</p>}
            {error && <p role="alert">{error}{receipt && " The displayed record remains available."}</p>}
            {receipt && <>
              <details><summary>About this record</summary><p>{receipt.detail}</p></details>
              {receipt.state !== "ready" && <p role="status">{receipt.state === "capturing" ? "WTS has not finished this record. Select Refresh record to check again." : receipt.state === "incomplete" ? "This record is incomplete. Some changes can be absent." : "This task has no complete change record. Open the current local changes to inspect the workspace."}</p>}
              {receipt.observation === "recovered" && <p>WTS recovered this record after an interruption. It can include changes from outside this task.</p>}
              {receipt.files.some(file => file.preExistingChange) && <p>Some files had local changes before this task. The patch compares the recorded before and after states.</p>}
              <details className={styles.files}>
                <summary>{receipt.files.length} {receipt.files.length === 1 ? "file" : "files"} changed{receipt.omittedFileCount > 0 ? ` · ${receipt.omittedFileCount} omitted` : ""}</summary>
                <ul>{receipt.files.map(file => <li key={file.filePath}><code>{file.filePath}</code><span>{file.status === "typeChanged" ? "Type changed" : file.status}</span>{file.preExistingChange && <span>Local changes before task</span>}{file.detail && <p>{file.detail}</p>}</li>)}</ul>
              </details>
              {receipt.patchTruncated && <p role="status">The patch is incomplete. Some changed lines are not shown.</p>}
              {!receipt.patch && <p>{receipt.files.length ? "No text patch is available for these changes." : receipt.state === "ready" ? "WTS observed no file changes during this task." : "No file changes are available in this record."}</p>}
            </>}
          </div>
          {receipt && <AgentResultActions client={client} receipt={receipt} calloutScope={calloutScope} onLeaveReview={() => { setOpen(false); onCloseFeedback?.(); }} onOpenVerification={() => { setOpen(false); onCloseFeedback?.(); window.dispatchEvent(new CustomEvent("wts:open-agent-workspace", { detail: { workspaceId, repositoryId, tab: "verification" } })); }} />}
          {receipt?.patch && <div className={styles.patch}>
            <Suspense fallback={<p role="status">WTS opens the recorded patch.</p>}><RepositoryPatchViewer patch={receipt.patch} theme={resolvedTheme} disableFullFile singleFile={receipt.files.length === 1 && receipt.omittedFileCount === 0} calloutPrefix={calloutScope ? { id: `${calloutScope.id}.review`, label: `${calloutScope.label} result` } : { id: "agent-result-review", label: "Task result" }} /></Suspense>
          </div>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
