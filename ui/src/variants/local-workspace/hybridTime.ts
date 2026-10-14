import type {
  ActivityWatchSessionCandidate,
  AgentProvider,
  AgentSession,
  ObservedAgentSession,
  UnassignedAgentWork,
} from "../../lib/wtsClient";

/** One period on the hybrid timeline. Times are Unix milliseconds. */
export interface TimeSpan {
  startedAtUnixMs: number;
  endedAtUnixMs: number;
}

export interface UserTimeBlock extends TimeSpan {
  id: string;
  track: "user";
  application: string;
  kind: ActivityWatchSessionCandidate["kind"];
  detail: string;
  durationMs: number;
  jiraIssueKey?: string;
}

export interface AgentTimeBlock extends TimeSpan {
  id: string;
  track: "agent";
  provider: AgentProvider | "copilot";
  providerLabel: string;
  /** Empty for a chat that no saved workspace shows. */
  workspaceId: string;
  source: "vsCode" | "terminal" | "outsideWorkspace";
  /** A short label for a chat outside saved workspaces, such as "Codex app · beacon_oncalls". */
  chatLabel?: string;
  detail: string;
  durationMs: number;
  ongoing: boolean;
}

export interface HybridTimeSummary {
  userMs: number;
  /** Agent work hours. Two agents that work for one hour at the same time count as two hours. */
  agentMs: number;
  /** Wall-clock time in which at least one agent worked. */
  agentWallMs: number;
  /** Time in which the user and at least one agent worked at the same time. */
  overlapMs: number;
  /** User time plus agent work hours: the total work delivered in the period. */
  combinedMs: number;
  /** Agent hours for each hour of user time. Null when the user has no active time. */
  multiplier: number | null;
  userBlocks: UserTimeBlock[];
  agentBlocks: AgentTimeBlock[];
  overlaps: TimeSpan[];
}

const providerNames: Record<string, string> = {
  codex: "Codex",
  openCode: "OpenCode",
  hermes: "Hermes",
  copilot: "Copilot",
};

const clientNames: Record<UnassignedAgentWork["client"], string> = {
  codexApp: "Codex app",
  codexCli: "Codex CLI",
  codexVscode: "Codex in VS Code",
  other: "Codex",
};

export function unassignedWorkLabel(work: UnassignedAgentWork) {
  return work.folderName ? `${clientNames[work.client]} · ${work.folderName}` : clientNames[work.client];
}

function clip(span: TimeSpan, range: TimeSpan): TimeSpan | null {
  const startedAtUnixMs = Math.max(span.startedAtUnixMs, range.startedAtUnixMs);
  const endedAtUnixMs = Math.min(span.endedAtUnixMs, range.endedAtUnixMs);
  return endedAtUnixMs > startedAtUnixMs ? { startedAtUnixMs, endedAtUnixMs } : null;
}

/** Joins spans that touch or overlap. The result is sorted and has no overlaps. */
export function mergeSpans(spans: readonly TimeSpan[]): TimeSpan[] {
  const sorted = [...spans]
    .filter((span) => span.endedAtUnixMs > span.startedAtUnixMs)
    .sort((left, right) => left.startedAtUnixMs - right.startedAtUnixMs);
  const merged: TimeSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.startedAtUnixMs <= last.endedAtUnixMs) {
      last.endedAtUnixMs = Math.max(last.endedAtUnixMs, span.endedAtUnixMs);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

export function spanTotal(spans: readonly TimeSpan[]) {
  return spans.reduce((total, span) => total + (span.endedAtUnixMs - span.startedAtUnixMs), 0);
}

/** Returns the periods that are in both sorted, non-overlapping lists. */
export function intersectSpans(left: readonly TimeSpan[], right: readonly TimeSpan[]): TimeSpan[] {
  const result: TimeSpan[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const startedAtUnixMs = Math.max(left[i]!.startedAtUnixMs, right[j]!.startedAtUnixMs);
    const endedAtUnixMs = Math.min(left[i]!.endedAtUnixMs, right[j]!.endedAtUnixMs);
    if (endedAtUnixMs > startedAtUnixMs) result.push({ startedAtUnixMs, endedAtUnixMs });
    if (left[i]!.endedAtUnixMs < right[j]!.endedAtUnixMs) i += 1;
    else j += 1;
  }
  return result;
}

function activityDetail(activity: ObservedAgentSession["activity"]) {
  switch (activity) {
    case "thinking": return "Thinking";
    case "usingTools": return "Using tools";
    case "editing": return "Editing files";
    case "runningCommand": return "Running a command";
    case "searching": return "Searching";
    case "delegating": return "Working with a subagent";
    default: return "Worked on a turn";
  }
}

/**
 * Builds the agent track for a range. VS Code sessions use their recorded turn
 * periods, so time in which the agent waits for the user is not counted.
 * WTS terminal sessions count from start to end (or to the last heartbeat).
 */
export function agentBlocksInRange(
  sessions: readonly AgentSession[],
  observed: readonly ObservedAgentSession[],
  range: TimeSpan,
  now = Date.now(),
  unassigned: readonly UnassignedAgentWork[] = [],
): AgentTimeBlock[] {
  const blocks: AgentTimeBlock[] = [];
  // Chats outside saved workspaces (Codex app, CLI). Parallel chats add together.
  for (const work of unassigned) {
    for (const [index, period] of work.workPeriods.entries()) {
      const end = period.ongoing && work.working
        ? Math.max(period.endedAtUnixMs, Math.min(now, range.endedAtUnixMs, work.lastEventAtUnixMs + 300_000))
        : period.endedAtUnixMs;
      const clipped = clip({ startedAtUnixMs: period.startedAtUnixMs, endedAtUnixMs: end }, range);
      if (!clipped) continue;
      blocks.push({
        ...clipped,
        id: `${work.sessionId}:${index}`,
        track: "agent",
        provider: work.provider,
        providerLabel: providerNames[work.provider] ?? work.provider,
        workspaceId: "",
        source: "outsideWorkspace",
        chatLabel: unassignedWorkLabel(work),
        detail: period.ongoing ? "Working on a turn" : "Finished a turn",
        durationMs: clipped.endedAtUnixMs - clipped.startedAtUnixMs,
        ongoing: Boolean(period.ongoing && work.working),
      });
    }
  }
  for (const session of observed) {
    for (const [index, period] of (session.workPeriods ?? []).entries()) {
      const clipped = clip(
        { startedAtUnixMs: period.startedAtUnixMs, endedAtUnixMs: period.ongoing && session.status === "working" && !session.needsInput ? Math.max(period.endedAtUnixMs, Math.min(now, range.endedAtUnixMs, session.lastEventAtUnixMs + 300_000)) : period.endedAtUnixMs },
        range,
      );
      if (!clipped) continue;
      blocks.push({
        ...clipped,
        id: `${session.sessionId}:${index}`,
        track: "agent",
        provider: session.provider,
        providerLabel: providerNames[session.provider] ?? session.provider,
        workspaceId: session.workspaceId,
        source: "vsCode",
        detail: period.ongoing ? activityDetail(session.activity) : "Finished a turn",
        durationMs: clipped.endedAtUnixMs - clipped.startedAtUnixMs,
        ongoing: Boolean(period.ongoing),
      });
    }
  }
  for (const session of sessions) {
    if (session.status === "launching" || session.status === "handoffAccepted") continue;
    const end = session.endedAtUnixMs ?? (session.status === "running" ? now : session.lastHeartbeatAtUnixMs);
    const clipped = clip({ startedAtUnixMs: session.startedAtUnixMs, endedAtUnixMs: end }, range);
    if (!clipped) continue;
    blocks.push({
      ...clipped,
      id: session.sessionId,
      track: "agent",
      provider: session.provider,
      providerLabel: providerNames[session.provider] ?? session.provider,
      workspaceId: session.workspaceId,
      source: "terminal",
      detail: session.category === "uncategorized" ? "Background task" : `Background ${session.category} task`,
      durationMs: clipped.endedAtUnixMs - clipped.startedAtUnixMs,
      ongoing: session.status === "running",
    });
  }
  return blocks.sort((left, right) => left.startedAtUnixMs - right.startedAtUnixMs);
}

export function userBlocksInRange(
  activity: readonly ActivityWatchSessionCandidate[],
  range: TimeSpan,
): UserTimeBlock[] {
  return activity.flatMap((session) => {
    const clipped = clip(session, range);
    if (!clipped) return [];
    return [{
      ...clipped,
      id: session.id,
      track: "user" as const,
      application: session.application ?? "Unknown application",
      kind: session.kind,
      detail: session.activityEvidence ?? session.description,
      // ActivityWatch reports active seconds. A block can include short idle gaps.
      durationMs: Math.min(session.durationSeconds * 1_000, clipped.endedAtUnixMs - clipped.startedAtUnixMs),
      ...(session.jiraIssueKey ? { jiraIssueKey: session.jiraIssueKey } : {}),
    }];
  });
}

/** Combines user activity and agent work for one range. */
export function summarizeHybridTime(
  userBlocks: readonly UserTimeBlock[],
  agentBlocks: readonly AgentTimeBlock[],
  userActiveMs?: number,
): HybridTimeSummary {
  const userSpans = mergeSpans(userBlocks);
  const agentSpans = mergeSpans(agentBlocks);
  const overlaps = intersectSpans(userSpans, agentSpans);
  const userMs = userActiveMs ?? spanTotal(userSpans);
  const agentMs = agentBlocks.reduce((total, block) => total + block.durationMs, 0);
  const agentWallMs = spanTotal(agentSpans);
  const overlapMs = spanTotal(overlaps);
  return {
    userMs,
    agentMs,
    agentWallMs,
    overlapMs,
    combinedMs: userMs + agentMs,
    multiplier: userMs > 0 ? agentMs / userMs : null,
    userBlocks: [...userBlocks],
    agentBlocks: [...agentBlocks],
    overlaps,
  };
}

export function formatDuration(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return ms > 0 ? "<1m" : "0m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function formatHours(ms: number) {
  const hours = ms / 3_600_000;
  return hours >= 10 ? `${Math.round(hours)} hrs` : `${hours.toFixed(1)} hrs`;
}

/**
 * Returns the whole-hour window that holds all work, so the timeline does not
 * show long empty periods. The window is inside the range and is at least two hours.
 */
export function timelineWindow(spans: readonly TimeSpan[], range: TimeSpan, now = Date.now()): TimeSpan {
  const end = Math.min(range.endedAtUnixMs, now);
  const starts = spans.map((span) => span.startedAtUnixMs);
  const ends = spans.map((span) => span.endedAtUnixMs);
  const first = Math.max(range.startedAtUnixMs, Math.min(end - 2 * 3_600_000, ...starts));
  const last = Math.min(range.endedAtUnixMs, Math.max(end, ...ends));
  const floorHour = (value: number) => { const d = new Date(value); d.setMinutes(0, 0, 0); return d.getTime(); };
  const ceilHour = (value: number) => { const f = floorHour(value); return f === value ? f : f + 3_600_000; };
  const startedAtUnixMs = Math.max(floorHour(range.startedAtUnixMs), floorHour(first));
  return { startedAtUnixMs, endedAtUnixMs: Math.max(startedAtUnixMs + 3_600_000, ceilHour(last)) };
}

export interface BlockGroup<T extends TimeSpan & { durationMs: number }> extends TimeSpan {
  id: string;
  durationMs: number;
  items: T[];
}

/**
 * Joins blocks that are closer than the gap, so short neighboring blocks show
 * as one target on the timeline. The duration is the sum of the item durations.
 */
export function groupBlocks<T extends TimeSpan & { durationMs: number; id: string }>(
  blocks: readonly T[],
  gapMs: number,
): BlockGroup<T>[] {
  const sorted = [...blocks].sort((left, right) => left.startedAtUnixMs - right.startedAtUnixMs);
  const groups: BlockGroup<T>[] = [];
  for (const block of sorted) {
    const last = groups[groups.length - 1];
    if (last && block.startedAtUnixMs - last.endedAtUnixMs <= gapMs) {
      last.endedAtUnixMs = Math.max(last.endedAtUnixMs, block.endedAtUnixMs);
      last.durationMs += block.durationMs;
      last.items.push(block);
    } else {
      groups.push({
        id: block.id,
        startedAtUnixMs: block.startedAtUnixMs,
        endedAtUnixMs: block.endedAtUnixMs,
        durationMs: block.durationMs,
        items: [block],
      });
    }
  }
  return groups;
}

/** Sums durations by a key and returns the largest first. */
export function topByDuration<T extends { durationMs: number }>(items: readonly T[], key: (item: T) => string) {
  const totals = new Map<string, number>();
  for (const item of items) totals.set(key(item), (totals.get(key(item)) ?? 0) + item.durationMs);
  return [...totals.entries()].map(([name, durationMs]) => ({ name, durationMs })).sort((a, b) => b.durationMs - a.durationMs);
}

/** A portable summary for a ticket or team update. It contains no agent transcript. */
export function buildHybridTimeExport(
  summary: HybridTimeSummary,
  range: TimeSpan,
  assignments: Readonly<Record<string, string>> = {},
): string {
  const ticketOf = (block: UserTimeBlock) =>
    block.id in assignments ? assignments[block.id] || undefined : block.jiraIssueKey;
  const byTicket = topByDuration(
    summary.userBlocks.filter((block) => ticketOf(block)),
    (block) => ticketOf(block)!,
  );
  const lines = [
    "# Work summary",
    `${new Date(range.startedAtUnixMs).toISOString()} to ${new Date(range.endedAtUnixMs).toISOString()}`,
    "", `- Your active time: ${formatDuration(summary.userMs)}`,
    `- Recorded agent time: ${formatDuration(summary.agentMs)}`,
    `- Combined time: ${formatDuration(summary.combinedMs)}`,
    `- Agent/user time ratio: ${summary.multiplier === null ? "Unavailable without user time" : summary.multiplier.toFixed(1) + "x"}`,
    "", "Parallel sessions add together. Time does not measure output quality.",
    ...(byTicket.length ? ["", "## Time by Jira ticket", ...byTicket.map((row) => `- ${row.name}: ${formatDuration(row.durationMs)}`)] : []),
    "", "## Work blocks",
    ...summary.userBlocks.map(block => `- ${block.application.replace(/[\r\n]/g, " ")}: ${formatDuration(block.durationMs)}${ticketOf(block) ? " · " + ticketOf(block) : ""}`),
    "", "## Agent work",
    ...summary.agentBlocks.map(block => `- ${block.providerLabel}: ${formatDuration(block.durationMs)}`),
  ];
  return lines.join("\n") + "\n";
}
