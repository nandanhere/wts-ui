import { useWorkspaceAttention } from "./useWorkspaceAttention";
import { useState } from "react";
import type { WorkspaceAttentionHistoryItem, WorkspaceAttentionItem, WorkspaceAttentionKind, WorkspaceAttentionSource, WorkspaceAttentionStore } from "./workspaceAttention";
import { Glyph } from "./Glyph";
import styles from "./WorkspaceAttentionCard.module.css";

const sourceNames: Record<WorkspaceAttentionKind, string> = { agent: "Agent results", verification: "Checks", gitlab: "GitLab" };
function updatedLabel(time: number | null) {
  if (time === null) return "Not checked";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  return minutes === 0 ? "Checked just now" : minutes < 60 ? `Checked ${minutes} min ago` : `Checked ${new Date(time).toLocaleString()}`;
}

export function ConnectedBoardAttentionStatus({ store }: { store: WorkspaceAttentionStore }) {
  const state = useWorkspaceAttention(store, snapshot => ({ items: snapshot.items, refreshing: snapshot.refreshing }),
    (left, right) => left.items === right.items && left.refreshing === right.refreshing);
  return <BoardAttentionStatus {...state} />;
}

export function ConnectedWorkspaceAttentionCard({ store, ...props }: {
  store: WorkspaceAttentionStore;
  workspaceId: string;
  workspaceLabel: string;
  onOpen: (item: WorkspaceAttentionItem) => void;
  onRefresh: () => void;
}) {
  const state = useWorkspaceAttention(store, snapshot => ({
    items: snapshot.items.filter(item => item.workspaceId === props.workspaceId),
    history: snapshot.history.filter(item => item.workspaceId === props.workspaceId),
    sources: snapshot.sources[props.workspaceId],
  }), (left, right) => left.sources === right.sources && left.items.length === right.items.length &&
    left.items.every((item, index) => item === right.items[index]) && left.history.length === right.history.length &&
    left.history.every((item, index) => item.id === right.history[index]?.id && item.revision === right.history[index]?.revision && item.resolvedAt === right.history[index]?.resolvedAt));
  return <WorkspaceAttentionCard {...props} {...state} onAcknowledge={item => store.acknowledge(item.id, item.revision)} />;
}

export function BoardAttentionStatus({ items, refreshing }: { items: WorkspaceAttentionItem[]; refreshing: boolean }) {
  const results = items.filter(item => item.kind === "agent").length;
  const checks = items.filter(item => item.kind === "verification").length;
  const unread = items.filter(item => item.kind === "gitlab").reduce((sum, item) => sum + item.count, 0);
  return <div className={styles.overview} data-ui="spaces.attention-summary" data-ui-label="Workspace attention summary">
    <b>Needs your attention <span>{items.length}</span></b>
    <span>{results} agent {results === 1 ? "result" : "results"} · {checks} failed {checks === 1 ? "check" : "checks"} · {unread} unread {unread === 1 ? "comment" : "comments"}</span>
    {refreshing && <small role="status">WTS checks status…</small>}
  </div>;
}

export function WorkspaceAttentionCard({ workspaceId, workspaceLabel, items, history, sources, onOpen, onAcknowledge, onRefresh }: {
  workspaceId: string;
  workspaceLabel: string;
  items: WorkspaceAttentionItem[];
  history: WorkspaceAttentionHistoryItem[];
  sources?: Record<WorkspaceAttentionKind, WorkspaceAttentionSource>;
  onOpen: (item: WorkspaceAttentionItem) => void;
  onAcknowledge: (item: WorkspaceAttentionItem) => void;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const sourceEntries = sources ? Object.entries(sources) as [WorkspaceAttentionKind, WorkspaceAttentionSource][] : [];
  const failures = sourceEntries.filter(([, source]) => source.status === "error" || source.status === "stale");
  const refreshing = sourceEntries.some(([, source]) => source.refreshing);
  const updated = sourceEntries.length && sourceEntries.every(([, source]) => source.updatedAt !== null)
    ? Math.min(...sourceEntries.map(([, source]) => source.updatedAt!)) : null;
  const visible = expanded ? items : items.slice(0, 3);
  return <section className={styles.card} aria-label={`${workspaceLabel} attention`}
    data-ui={`spaces.attention.${workspaceId}`} data-ui-label={`${workspaceLabel} attention`}>
    {!!items.length && <ul className={styles.items}>{visible.map(item => <li key={item.id}>
      <button className={styles.open} type="button" onClick={() => onOpen(item)}>
        <Glyph name={item.kind === "verification" ? "warning" : item.kind === "gitlab" ? "comment" : "check"} size={14} />
        <span><b>{item.label}</b><small>{item.detail}</small></span>
        {item.kind === "gitlab" && <span className={styles.count} aria-label={`${item.count} unread comments`}>{item.count}</span>}
      </button>
      {item.kind === "agent" && <button className={styles.reviewed} type="button"
        aria-label={`Mark ${item.label} as reviewed`} title="Mark as reviewed" onClick={() => onAcknowledge(item)}>
        <Glyph name="check" size={13} /><span>Reviewed</span>
      </button>}
    </li>)}</ul>}
    {items.length > 3 && <button className={styles.more} type="button" onClick={() => setExpanded(value => !value)}>
      {expanded ? "Show fewer items" : `Show ${items.length - 3} more items`}
    </button>}
    {!!failures.length && <p className={styles.failure}>
      {failures.map(([kind]) => sourceNames[kind]).join(" and ")} status is unavailable. Saved items remain visible.
      <button type="button" disabled={refreshing} onClick={onRefresh}>Retry status</button>
    </p>}
    <div className={styles.footer}>
      <details className={styles.status}>
        <summary>{refreshing ? "WTS checks status…" : updatedLabel(updated)}{failures.length ? " · Stale" : ""}</summary>
        <ul>{sourceEntries.map(([kind, source]) => <li key={kind}>
          <b>{sourceNames[kind]}</b><span>{updatedLabel(source.updatedAt)}</span>
          {(source.error || source.detail) && <p>{source.error || source.detail}</p>}
        </li>)}</ul>
      </details>
      {!!history.length && <details className={styles.history}>
        <summary>History ({history.length})</summary>
        <ul>{history.map(item => <li key={`${item.id}:${item.revision}`}>
          <button type="button" onClick={() => onOpen(item)}>{item.label}<small>{new Date(item.resolvedAt).toLocaleString()}</small></button>
        </li>)}</ul>
      </details>}
    </div>
  </section>;
}
