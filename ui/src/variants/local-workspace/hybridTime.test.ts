import { describe, expect, it } from "vitest";
import type { ActivityWatchSessionCandidate, AgentSession, ObservedAgentSession } from "../../lib/wtsClient";
import {
  agentBlocksInRange,
  formatDuration,
  groupBlocks,
  topByDuration,
  intersectSpans,
  mergeSpans,
  summarizeHybridTime,
  timelineWindow,
  userBlocksInRange,
} from "./hybridTime";

const H = 3_600_000;
const M = 60_000;
const day = new Date(2026, 8, 29, 0, 0).getTime();
const range = { startedAtUnixMs: day, endedAtUnixMs: day + 24 * H };

function observed(id: string, periods: ObservedAgentSession["workPeriods"]): ObservedAgentSession {
  return {
    schemaVersion: 1,
    sessionId: id,
    workspaceId: "ws_1",
    provider: "codex",
    source: "codexVscodeRollout",
    status: "idle",
    activity: null,
    startedAtUnixMs: day,
    lastEventAtUnixMs: day,
    workPeriods: periods,
  } as ObservedAgentSession;
}

function terminal(partial: Partial<AgentSession>): AgentSession {
  return {
    schemaVersion: 1,
    sessionId: "t1",
    workspaceId: "ws_2",
    provider: "hermes",
    terminal: "terminal",
    category: "verification",
    status: "completed",
    startedAtUnixMs: day + 9 * H,
    lastHeartbeatAtUnixMs: day + 10 * H,
    endedAtUnixMs: day + 10 * H,
    failure: null,
    ...partial,
  };
}

function activity(id: string, start: number, end: number): ActivityWatchSessionCandidate {
  return {
    id,
    kind: "coding",
    startedAtUnixMs: start,
    endedAtUnixMs: end,
    durationSeconds: (end - start) / 1_000,
    description: "Coding work",
    application: "Code",
    sourceEventCount: 1,
  };
}

describe("hybrid time engine", () => {
  it("merges touching spans and intersects two tracks", () => {
    const merged = mergeSpans([
      { startedAtUnixMs: 30, endedAtUnixMs: 40 },
      { startedAtUnixMs: 0, endedAtUnixMs: 10 },
      { startedAtUnixMs: 10, endedAtUnixMs: 20 },
    ]);
    expect(merged).toEqual([
      { startedAtUnixMs: 0, endedAtUnixMs: 20 },
      { startedAtUnixMs: 30, endedAtUnixMs: 40 },
    ]);
    expect(intersectSpans(merged, [{ startedAtUnixMs: 15, endedAtUnixMs: 35 }])).toEqual([
      { startedAtUnixMs: 15, endedAtUnixMs: 20 },
      { startedAtUnixMs: 30, endedAtUnixMs: 35 },
    ]);
  });

  it("counts parallel agents as separate work hours but overlap as wall time", () => {
    const agents = agentBlocksInRange(
      [],
      [
        observed("a", [{ startedAtUnixMs: day + 9 * H, endedAtUnixMs: day + 11 * H }]),
        observed("b", [{ startedAtUnixMs: day + 10 * H, endedAtUnixMs: day + 12 * H }]),
      ],
      range,
    );
    const user = userBlocksInRange([activity("u", day + 10 * H, day + 11 * H)], range);
    const summary = summarizeHybridTime(user, agents);
    expect(summary.agentMs).toBe(4 * H);
    expect(summary.agentWallMs).toBe(3 * H);
    expect(summary.userMs).toBe(H);
    expect(summary.overlapMs).toBe(H);
    expect(summary.combinedMs).toBe(5 * H);
    expect(summary.multiplier).toBe(4);
  });

  it("clips periods to the range and extends ongoing turns to now", () => {
    const now = day + 15 * H;
    const blocks = agentBlocksInRange(
      [],
      [{ ...observed("a", [
        { startedAtUnixMs: day - H, endedAtUnixMs: day + H },
        { startedAtUnixMs: day + 14 * H, endedAtUnixMs: day + 14 * H + 5 * M, ongoing: true },
      ]), status: "working", lastEventAtUnixMs: now - M }],
      range,
      now,
    );
    expect(blocks.map((block) => block.durationMs)).toEqual([H, H]);
    expect(blocks[1]!.ongoing).toBe(true);
  });

  it("does not add time after a stale agent stops sending events", () => {
    const session = observed("stale", [{ startedAtUnixMs: day + H, endedAtUnixMs: day + 2 * H, ongoing: true }]);
    session.status = "stale";
    expect(agentBlocksInRange([], [session], range, day + 12 * H)[0]!.durationMs).toBe(H);
    session.status = "working";
    session.lastEventAtUnixMs = day + 2 * H;
    expect(agentBlocksInRange([], [session], range, day + 12 * H)[0]!.durationMs).toBe(H + 5 * M);
    session.needsInput = { kind: "question", detail: "Agent has a question." };
    expect(agentBlocksInRange([], [session], range, day + 12 * H)[0]!.durationMs).toBe(H);
  });

  it("counts terminal sessions from start to end and skips sessions that never started", () => {
    const now = day + 20 * H;
    const blocks = agentBlocksInRange(
      [
        terminal({}),
        terminal({ sessionId: "run", status: "running", startedAtUnixMs: day + 19 * H, endedAtUnixMs: null }),
        terminal({ sessionId: "pending", status: "launching", endedAtUnixMs: null }),
      ],
      [],
      range,
      now,
    );
    expect(blocks.map((block) => [block.id, block.durationMs])).toEqual([
      ["t1", H],
      ["run", H],
    ]);
  });

  it("reports no multiplier without user time", () => {
    expect(summarizeHybridTime([], []).multiplier).toBeNull();
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(90 * M)).toBe("1h 30m");
  });

  it("fits the timeline window to the hours that have work", () => {
    const window = timelineWindow(
      [{ startedAtUnixMs: day + 9 * H + 20 * M, endedAtUnixMs: day + 10 * H }],
      range,
      day + 11 * H + 10 * M,
    );
    expect(window).toEqual({ startedAtUnixMs: day + 9 * H, endedAtUnixMs: day + 12 * H });
  });
});

describe("timeline groups", () => {
  it("joins blocks that are closer than the gap and keeps distant blocks apart", () => {
    const blocks = [
      { id: "a", startedAtUnixMs: 0, endedAtUnixMs: 60_000, durationMs: 60_000 },
      { id: "b", startedAtUnixMs: 90_000, endedAtUnixMs: 120_000, durationMs: 30_000 },
      { id: "c", startedAtUnixMs: 600_000, endedAtUnixMs: 660_000, durationMs: 60_000 },
    ];
    const groups = groupBlocks(blocks, 60_000);
    expect(groups.map((group) => [group.id, group.items.length, group.durationMs, group.endedAtUnixMs])).toEqual([
      ["a", 2, 90_000, 120_000],
      ["c", 1, 60_000, 660_000],
    ]);
    expect(topByDuration(blocks, (block) => (block.id === "b" ? "Slack" : "Code"))).toEqual([
      { name: "Code", durationMs: 120_000 },
      { name: "Slack", durationMs: 30_000 },
    ]);
  });
});
