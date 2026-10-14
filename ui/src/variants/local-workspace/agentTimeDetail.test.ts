import { describe, expect, it } from "vitest";
import { agentBlocksInRange } from "./hybridTime";
import { agentClockMs, agentTimeDetail, workspaceDisplayName } from "./AgentSessionsPanel";

const M = 60_000;
const day = new Date(2026, 9, 8, 0, 0).getTime();
const at = (hours: number, minutes: number) => day + (hours * 60 + minutes) * M;
const range = { startedAtUnixMs: day, endedAtUnixMs: day + 24 * 60 * M };
const turns = (pairs: Array<[number, number, number, number]>) =>
  pairs.map(([h1, m1, h2, m2]) => ({ startedAtUnixMs: at(h1, m1), endedAtUnixMs: at(h2, m2) }));

// The 12 turns from 10:31 to 11:49 on 8 October 2026, read from the Codex chat logs.
function blocks() {
  const chat = (sessionId: string, workspaceId: string, workPeriods: ReturnType<typeof turns>) => ({
    schemaVersion: 1, sessionId, workspaceId, provider: "codex", source: "codexVscodeRollout", status: "idle", activity: null,
    startedAtUnixMs: at(10, 0), lastEventAtUnixMs: at(12, 0), workPeriods,
  }) as never;
  return agentBlocksInRange([], [
    chat("wts", "ws_wts", turns([[10, 31, 10, 50], [10, 55, 11, 3], [11, 3, 11, 15], [11, 15, 11, 38], [11, 38, 11, 47]])),
    chat("beacon", "ws_beacon", turns([[11, 1, 11, 3], [11, 28, 11, 30], [11, 35, 11, 37], [11, 41, 11, 41.5], [11, 45, 11, 49]])),
  ], range, at(13, 0), [{
    sessionId: "app", provider: "codex", client: "codexApp", folderName: "beacon_oncalls",
    startedAtUnixMs: at(10, 0), lastEventAtUnixMs: at(11, 0),
    workPeriods: turns([[10, 44, 10, 45], [10, 53, 10, 54]]),
  }]);
}

describe("agent time detail", () => {
  it("shows the clock time next to the added chat time", () => {
    const work = blocks();
    expect(work).toHaveLength(12);
    const added = work.reduce((total, block) => total + block.durationMs, 0);
    expect(Math.round(added / M)).toBe(84);
    expect(Math.round(agentClockMs(work) / M)).toBe(74);
    expect(agentTimeDetail(work)).toBe("1h 14m on the clock · 3 chats · 1 outside saved workspaces. Chats that run at the same time each add their time.");
  });

  it("names a workspace one time when its key and title are the same", () => {
    expect(workspaceDisplayName({ key: "wts-ui", title: "wts-ui" })).toBe("wts-ui");
    expect(workspaceDisplayName({ key: "Beacon flow", title: "beacon flow" })).toBe("beacon flow");
    expect(workspaceDisplayName({ key: "TASK-42", title: "Orders retries" })).toBe("TASK-42 · Orders retries");
  });
});
