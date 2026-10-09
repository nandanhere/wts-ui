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

/** A card shows this many items in each group before "Show more". */
const VISIBLE_ITEMS = 3;

function ageLabel(time: number, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? hours + "h" : Math.floor(hours / 24) + "d";
}

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
      <span className={styles.statusEnd}>
        {refreshing && <small className={styles.checking} role="status"><Glyph name="refresh" size={12} /> Checking status…</small>}
        {!!unavailable?.workspaces && <span className={styles.staleStatus} role="note"
          data-ui="spaces.attention-stale" data-ui-label="Stale status" data-open={healthOpen || undefined}>
          <button type="button" className={styles.staleToggle} aria-expanded={healthOpen}
            aria-label={`${unavailable.names.join(" and ")} status is unavailable for ${plural(unavailable.workspaces, "workspace", "workspaces")}. ${healthOpen ? "Hide" : "Show"} status details`}
            onClick={() => setHealthOpen(value => !value)}>
            <span className={styles.staleDot} aria-hidden="true" />
            {unavailable.names.join(" and ")} status unavailable · {plural(unavailable.workspaces, "workspace", "workspaces")}
          </button>
          {healthOpen && <span className={styles.stalePanel}>
            <span>{unavailable.names.join(" and ")} status is unavailable for {plural(unavailable.workspaces, "workspace", "workspaces")}. The board shows the last known items. Open a workspace to see the status of each source.</span>
            {onRefresh && <button type="button" disabled={refreshing}
              onClick={() => { setHealthOpen(false); onRefresh(); }}>Retry status</button>}
          </span>}
        </span>}
      </span>
    </div>
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

/** The open attention items for one workspace. The board banner reports unavailable sources once. */
export function WorkspaceAttentionCard({ workspaceId, workspaceLabel, items, history, sources, kinds = ["verification", "gitlab", "agent"], onOpen, onAcknowledge }: {
  workspaceId: string;
  workspaceLabel: string;
  items: WorkspaceAttentionItem[];
  history: WorkspaceAttentionHistoryItem[];
  sources?: Record<WorkspaceAttentionKind, WorkspaceAttentionSource>;
  kinds?: readonly WorkspaceAttentionKind[];
  onOpen: (item: WorkspaceAttentionItem) => void;
  onAcknowledge: (item: WorkspaceAttentionItem) => void;
}) {
  const sourceEntries = sources ? Object.entries(sources) as [WorkspaceAttentionKind, WorkspaceAttentionSource][] : [];
  const stale = sourceEntries.some(([kind, source]) => kinds.includes(kind) && (source.status === "error" || source.status === "stale"));
  const updated = sourceEntries.length && sourceEntries.every(([, source]) => source.updatedAt !== null)
    ? Math.min(...sourceEntries.map(([, source]) => source.updatedAt!)) : null;
  const shownHistory = history.filter(item => kinds.includes(item.kind));
  const shownKinds = kinds.filter(kind => items.some(item => item.kind === kind));
  const [expandedKinds, setExpandedKinds] = useState<ReadonlySet<WorkspaceAttentionKind>>(() => new Set());
  if (!shownKinds.length && !shownHistory.length) return null;
  return <section className={styles.card} aria-label={workspaceLabel + " attention"}
    data-ui={"spaces.attention." + workspaceId} data-ui-label={workspaceLabel + " attention"}>
    {shownKinds.map(kind => {
      const group = items.filter(item => item.kind === kind);
      const detail = groupDetails[kind];
      const expanded = expandedKinds.has(kind);
      const visible = expanded ? group : group.slice(0, VISIBLE_ITEMS);
      const hidden = group.length - visible.length;
      const compact = kind === "agent";
      return <details key={kind} className={styles.group} data-kind={kind} open>
        <summary>
          <span className={styles.groupIcon} data-kind={kind} data-empty={!group.length || undefined}>
            <Glyph name={group.length ? detail.icon : "check"} size={13} />
          </span>
          <b>{detail.title}</b>
          <span className={styles.count}>{kind === "gitlab" ? group.reduce((sum, item) => sum + item.count, 0) : group.length}</span>
          <Glyph name="chevron" size={14} />
        </summary>
        {group.length ? <ul className={styles.items} data-compact={compact || undefined}>{visible.map(item => <li key={item.id}>
          <button className={styles.open} type="button" onClick={() => onOpen(item)}
            title={compact ? item.label + " · " + new Date(item.occurredAt).toLocaleString() : undefined}>
            <span className={styles.itemText}>
              <b className={kind === "gitlab" && item.target.kind === "gitlab" && item.target.filePath ? styles.path : undefined}>{item.label}</b>
              <small className={compact ? styles.srOnly : undefined}>{item.detail}</small>
            </span>
            {compact && <time className={styles.age} dateTime={new Date(item.occurredAt).toISOString()} aria-hidden="true">{ageLabel(item.occurredAt)}</time>}
            {item.kind === "gitlab" && <span className={styles.count} aria-label={item.count + " unread comments"}>{item.count}</span>}
            {!compact && <Glyph name="arrow" size={13} />}
          </button>
          {item.kind === "agent" && <button className={styles.reviewed} type="button"
            aria-label={"Mark " + item.label + " as reviewed"} title="Mark as reviewed" onClick={() => onAcknowledge(item)}>
            <Glyph name="check" size={13} />
          </button>}
        </li>)}
          {(hidden > 0 || (expanded && group.length > VISIBLE_ITEMS)) && <li className={styles.moreRow}>
            <button className={styles.more} type="button" aria-expanded={expanded}
              onClick={() => setExpandedKinds(current => {
                const next = new Set(current);
                if (next.has(kind)) next.delete(kind); else next.add(kind);
                return next;
              })}>
              {expanded ? "Show fewer" : "Show " + hidden + " more"}
            </button>
          </li>}
        </ul> : <p className={styles.empty}>{detail.empty}</p>}
      </details>;
    })}
    <div className={styles.footer}>
      {!!sourceEntries.length && <details className={styles.status}>
        <summary>{updatedLabel(updated)}{stale ? " · Stale" : ""}</summary>
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
