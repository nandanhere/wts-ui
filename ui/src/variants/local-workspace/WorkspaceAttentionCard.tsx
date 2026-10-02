import { useState } from "react";
import { useWorkspaceAttention } from "./useWorkspaceAttention";
import type { WorkspaceAttentionHistoryItem, WorkspaceAttentionItem, WorkspaceAttentionKind, WorkspaceAttentionSource, WorkspaceAttentionStore } from "./workspaceAttention";
import { Glyph, type GlyphName } from "./Glyph";
import styles from "./WorkspaceAttentionCard.module.css";

const sourceNames: Record<WorkspaceAttentionKind, string> = { agent: "Agent results", verification: "Checks", gitlab: "GitLab" };
function updatedLabel(time: number | null) {
  if (time === null) return "Not checked";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  return minutes === 0 ? "Checked just now" : minutes < 60 ? "Checked " + minutes + " min ago" : "Checked " + new Date(time).toLocaleString();
}
function plural(count: number, one: string, many: string) { return count + " " + (count === 1 ? one : many); }

export type AttentionFilter = WorkspaceAttentionKind | null;

/** Counts for one workspace or for the board. Unread comments count comments, not threads. */
export function attentionTotals(items: readonly WorkspaceAttentionItem[]) {
  return {
    agent: items.filter(item => item.kind === "agent").length,
    verification: items.filter(item => item.kind === "verification").length,
    gitlab: items.filter(item => item.kind === "gitlab").reduce((sum, item) => sum + item.count, 0),
  } satisfies Record<WorkspaceAttentionKind, number>;
}

/** Workspace IDs that have at least one open item of the kind. */
export function workspacesWithAttention(items: readonly WorkspaceAttentionItem[], kind: WorkspaceAttentionKind) {
  return new Set(items.filter(item => item.kind === kind).map(item => item.workspaceId));
}

/** Names the sources that failed for each workspace. The board shows them once. */
export function unavailableSourceNames(sources: Record<string, Record<WorkspaceAttentionKind, WorkspaceAttentionSource> | undefined>) {
  const names = new Set<string>();
  let workspaces = 0;
  for (const workspaceSources of Object.values(sources)) {
    if (!workspaceSources) continue;
    const failed = (Object.entries(workspaceSources) as [WorkspaceAttentionKind, WorkspaceAttentionSource][])
      .filter(([, source]) => source.status === "error" || source.status === "stale");
    if (!failed.length) continue;
    workspaces += 1;
    failed.forEach(([kind]) => names.add(sourceNames[kind]));
  }
  return { names: [...names], workspaces };
}

const chipDetails: Array<{ kind: WorkspaceAttentionKind; icon: GlyphName; one: string; many: string; tone: string }> = [
  { kind: "agent", icon: "check", one: "agent result", many: "agent results", tone: "blue" },
  { kind: "verification", icon: "warning", one: "failed check", many: "failed checks", tone: "red" },
  { kind: "gitlab", icon: "comment", one: "unread comment", many: "unread comments", tone: "amber" },
];

export function ConnectedBoardAttentionStatus({ store, onRefresh, filter, onFilter }: {
  store: WorkspaceAttentionStore;
  onRefresh?: () => void;
  filter?: AttentionFilter;
  onFilter?: (filter: AttentionFilter) => void;
}) {
  const state = useWorkspaceAttention(store, snapshot => ({ items: snapshot.items, refreshing: snapshot.refreshing, sources: snapshot.sources }),
    (left, right) => left.items === right.items && left.refreshing === right.refreshing && left.sources === right.sources);
  return <BoardAttentionStatus items={state.items} refreshing={state.refreshing}
    unavailable={unavailableSourceNames(state.sources)} onRefresh={onRefresh} filter={filter} onFilter={onFilter} />;
}

/** Triage chips filter the board. The health banner reports stale sources once for the board. */
export function BoardAttentionStatus({ items, refreshing, unavailable, onRefresh, filter = null, onFilter }: {
  items: WorkspaceAttentionItem[];
  refreshing: boolean;
  unavailable?: { names: string[]; workspaces: number };
  onRefresh?: () => void;
  filter?: AttentionFilter;
  onFilter?: (filter: AttentionFilter) => void;
}) {
  const [healthOpen, setHealthOpen] = useState(false);
  const totals = attentionTotals(items);
  const workspaceCount = new Set(items.map(item => item.workspaceId)).size;
  return <div className={styles.overview} data-ui="spaces.attention-summary" data-ui-label="Workspace attention summary">
    <div className={styles.triage} role="group" aria-label="Filter by attention">
      <span className={styles.triageLead}>
        <b>Needs you</b>
        <span>{workspaceCount ? plural(workspaceCount, "workspace", "workspaces") : "Nothing waits for you"}</span>
      </span>
      {chipDetails.map(chip => {
        const count = totals[chip.kind];
        const selected = filter === chip.kind;
        return <button key={chip.kind} type="button" className={styles.chip} data-tone={chip.tone}
          aria-pressed={selected} disabled={!count && !selected}
          onClick={() => onFilter?.(selected ? null : chip.kind)}>
          <Glyph name={chip.icon} size={13} />
          <b>{count}</b> {count === 1 ? chip.one : chip.many}
        </button>;
      })}
      {filter && <button type="button" className={styles.clearChip} onClick={() => onFilter?.(null)}>
        <Glyph name="close" size={12} /> Show all
      </button>}
      {refreshing && <small className={styles.checking} role="status"><Glyph name="refresh" size={12} /> Checking status…</small>}
    </div>
    {!!unavailable?.workspaces && <div className={styles.boardFailure} role="note"
      data-ui="spaces.attention-stale" data-ui-label="Stale status banner" data-open={healthOpen || undefined}>
      <Glyph name="warning" size={14} />
      <span>{unavailable.names.join(" and ")} status is unavailable for {plural(unavailable.workspaces, "workspace", "workspaces")}. Saved items remain visible.</span>
      {onRefresh && <button type="button" disabled={refreshing} onClick={onRefresh}>Retry status</button>}
      <button type="button" className={styles.bannerToggle} aria-expanded={healthOpen}
        aria-label={healthOpen ? "Hide status details" : "Show status details"} onClick={() => setHealthOpen(value => !value)}>
        <Glyph name="chevron" size={14} />
      </button>
      {healthOpen && <p className={styles.bannerDetail}>WTS keeps the last known items. Retry status after the connection is available. Open a workspace to see the status of each source.</p>}
    </div>}
  </div>;
}

export function ConnectedWorkspaceAttentionBadges({ store, workspaceId }: { store: WorkspaceAttentionStore; workspaceId: string }) {
  const state = useWorkspaceAttention(store, snapshot => ({
    items: snapshot.items.filter(item => item.workspaceId === workspaceId),
    stale: Object.values(snapshot.sources[workspaceId] ?? {}).some(source => source.status === "error" || source.status === "stale"),
  }), (left, right) => left.stale === right.stale && left.items.length === right.items.length &&
    left.items.every((item, index) => item === right.items[index]));
  return <WorkspaceAttentionBadges items={state.items} stale={state.stale} />;
}

/** Aggregate badges for a card. Details stay in the inspector. */
export function WorkspaceAttentionBadges({ items, stale = false }: { items: readonly WorkspaceAttentionItem[]; stale?: boolean }) {
  const totals = attentionTotals(items);
  if (!totals.agent && !totals.verification && !totals.gitlab && !stale) return null;
  return <span className={styles.badges}>
    {!!totals.verification && <span className={styles.badge} data-tone="red"><Glyph name="warning" size={12} />{plural(totals.verification, "check failed", "checks failed")}</span>}
    {!!totals.gitlab && <span className={styles.badge} data-tone="amber"><Glyph name="comment" size={12} />{plural(totals.gitlab, "unread comment", "unread comments")}</span>}
    {!!totals.agent && <span className={styles.badge} data-tone="blue"><Glyph name="check" size={12} />{plural(totals.agent, "result to review", "results to review")}</span>}
    {stale && <span className={styles.badge} data-tone="muted" title="Some status is unavailable. Saved items remain visible.">Stale</span>}
  </span>;
}

export function ConnectedWorkspaceAttentionCard({ store, ...props }: {
  store: WorkspaceAttentionStore;
  workspaceId: string;
  workspaceLabel: string;
  kinds?: readonly WorkspaceAttentionKind[];
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

const groupDetails: Record<WorkspaceAttentionKind, { title: string; icon: GlyphName; empty: string }> = {
  verification: { title: "Checks", icon: "warning", empty: "No failed checks." },
  gitlab: { title: "Comment threads", icon: "comment", empty: "No unread comments." },
  agent: { title: "Agent results", icon: "check", empty: "No results to review." },
};

/** The full attention list for one workspace. The inspector shows it. */
export function WorkspaceAttentionCard({ workspaceId, workspaceLabel, items, history, sources, kinds = ["verification", "gitlab", "agent"], onOpen, onAcknowledge, onRefresh }: {
  workspaceId: string;
  workspaceLabel: string;
  items: WorkspaceAttentionItem[];
  history: WorkspaceAttentionHistoryItem[];
  sources?: Record<WorkspaceAttentionKind, WorkspaceAttentionSource>;
  kinds?: readonly WorkspaceAttentionKind[];
  onOpen: (item: WorkspaceAttentionItem) => void;
  onAcknowledge: (item: WorkspaceAttentionItem) => void;
  onRefresh: () => void;
}) {
  const sourceEntries = sources ? Object.entries(sources) as [WorkspaceAttentionKind, WorkspaceAttentionSource][] : [];
  const failures = sourceEntries.filter(([kind, source]) => kinds.includes(kind) && (source.status === "error" || source.status === "stale"));
  const refreshing = sourceEntries.some(([, source]) => source.refreshing);
  const updated = sourceEntries.length && sourceEntries.every(([, source]) => source.updatedAt !== null)
    ? Math.min(...sourceEntries.map(([, source]) => source.updatedAt!)) : null;
  const shownHistory = history.filter(item => kinds.includes(item.kind));
  return <section className={styles.card} aria-label={workspaceLabel + " attention"}
    data-ui={"spaces.attention." + workspaceId} data-ui-label={workspaceLabel + " attention"}>
    {!!failures.length && <p className={styles.failure}>
      <Glyph name="warning" size={13} />
      <span>{failures.map(([kind]) => sourceNames[kind]).join(" and ")} status is unavailable. Saved items remain visible.</span>
      <button type="button" disabled={refreshing} onClick={onRefresh} aria-label="Retry status">Retry</button>
    </p>}
    {kinds.map(kind => {
      const group = items.filter(item => item.kind === kind);
      const detail = groupDetails[kind];
      return <details key={kind} className={styles.group} data-kind={kind} open={group.length > 0}>
        <summary>
          <span className={styles.groupIcon} data-kind={kind} data-empty={!group.length || undefined}>
            <Glyph name={group.length ? detail.icon : "check"} size={13} />
          </span>
          <b>{detail.title}</b>
          <span className={styles.count}>{kind === "gitlab" ? group.reduce((sum, item) => sum + item.count, 0) : group.length}</span>
          <Glyph name="chevron" size={14} />
        </summary>
        {group.length ? <ul className={styles.items}>{group.map(item => <li key={item.id}>
          <button className={styles.open} type="button" onClick={() => onOpen(item)}>
            <span className={styles.itemText}>
              <b className={kind === "gitlab" && item.target.kind === "gitlab" && item.target.filePath ? styles.path : undefined}>{item.label}</b>
              <small>{item.detail}</small>
            </span>
            {item.kind === "gitlab" && <span className={styles.count} aria-label={item.count + " unread comments"}>{item.count}</span>}
            <Glyph name="arrow" size={13} />
          </button>
          {item.kind === "agent" && <button className={styles.reviewed} type="button"
            aria-label={"Mark " + item.label + " as reviewed"} title="Mark as reviewed" onClick={() => onAcknowledge(item)}>
            <Glyph name="check" size={13} /><span>Reviewed</span>
          </button>}
        </li>)}</ul> : <p className={styles.empty}>{detail.empty}</p>}
      </details>;
    })}
    <div className={styles.footer}>
      {!!sourceEntries.length && <details className={styles.status}>
        <summary>{refreshing ? "Checking status…" : updatedLabel(updated)}{failures.length ? " · Stale" : ""}</summary>
        <ul>{sourceEntries.map(([kind, source]) => <li key={kind}>
          <b>{sourceNames[kind]}</b><span>{updatedLabel(source.updatedAt)}</span>
          {(source.error || source.detail) && <p>{source.error || source.detail}</p>}
        </li>)}</ul>
      </details>}
      {!!shownHistory.length && <details className={styles.history}>
        <summary>History ({shownHistory.length})</summary>
        <ul>{shownHistory.map(item => <li key={item.id + ":" + item.revision}>
          <button type="button" onClick={() => onOpen(item)}>{item.label}<small>{new Date(item.resolvedAt).toLocaleString()}</small></button>
        </li>)}</ul>
      </details>}
    </div>
  </section>;
}
