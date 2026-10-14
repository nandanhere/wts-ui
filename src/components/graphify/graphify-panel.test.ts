/**
 * Tests for GraphifyPanel component (logic layer).
 *
 * Tests data-flow logic: filtering, status aggregation, summary
 * calculations.  Full render tests require Playwright or jsdom.
 *
 * Run: node --experimental-strip-types --loader ../../scripts/register-ts.mjs \
 *       --test src/components/graphify/graphify-panel.test.ts
 */

import { describe, it } from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert";
import type { GraphifyStatus } from "@/lib/graphify/types";

/* ------------------------------------------------------------------ */
/*  Mock status factory                                                */
/* ------------------------------------------------------------------ */

function makeStatus(
  overrides: Partial<GraphifyStatus> & { repoId: string }
): GraphifyStatus {
  return {
    repoId: overrides.repoId,
    repoRoot: `/repos/${overrides.repoId}`,
    graphifyCliAvailable: false,
    available: false,
    artifacts: {
      graphJson: false,
      wikiIndex: false,
      graphReport: false,
      graphHtml: false,
      manifest: false,
    },
    staleness: {
      status: "unknown",
      lastGraphCommitDate: null,
      lastRepoCommitDate: null,
      graphMtime: null,
    },
    capabilities: { operations: [] },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Summary bar logic                                                  */
/* ------------------------------------------------------------------ */

interface SummaryCounts {
  total: number;
  available: number;
  partial: number;
  absent: number;
}

function computeSummary(statuses: GraphifyStatus[]): SummaryCounts {
  const total = statuses.length;
  const available = statuses.filter((s) => s.available).length;
  const partial = statuses.filter(
    (s) => !s.available && s.artifacts.graphJson
  ).length;
  const absent = total - available - partial;
  return { total, available, partial, absent };
}

void describe("computeSummary", () => {
  void it("returns zeros for empty list", () => {
    const s = computeSummary([]);
    strictEqual(s.total, 0);
    strictEqual(s.available, 0);
    strictEqual(s.partial, 0);
    strictEqual(s.absent, 0);
  });

  void it("counts available repos", () => {
    const statuses = [
      makeStatus({ repoId: "a", available: true, artifacts: { graphJson: true, graphReport: true, wikiIndex: false, graphHtml: false, manifest: false } }),
      makeStatus({ repoId: "b", available: false }),
    ];
    const s = computeSummary(statuses);
    strictEqual(s.available, 1);
    strictEqual(s.absent, 1);
    strictEqual(s.partial, 0);
  });

  void it("counts partial repos (graphJson but not available)", () => {
    const statuses = [
      makeStatus({
        repoId: "p",
        available: false,
        artifacts: { graphJson: true, graphReport: false, wikiIndex: false, graphHtml: false, manifest: false },
      }),
      makeStatus({ repoId: "a", available: true, artifacts: { graphJson: true, graphReport: true, wikiIndex: false, graphHtml: false, manifest: false } }),
      makeStatus({ repoId: "x", available: false }),
    ];
    const s = computeSummary(statuses);
    strictEqual(s.available, 1);
    strictEqual(s.partial, 1);
    strictEqual(s.absent, 1);
    strictEqual(s.total, 3);
  });
});

/* ------------------------------------------------------------------ */
/*  Filtering logic (mirrors the GraphifyPanel useMemo)               */
/* ------------------------------------------------------------------ */

function filterStatuses(
  statuses: GraphifyStatus[],
  search: string
): GraphifyStatus[] {
  if (!search) return statuses;
  return statuses.filter(
    (s) =>
      s.repoId.toLowerCase().includes(search.toLowerCase()) ||
      s.repoRoot.toLowerCase().includes(search.toLowerCase())
  );
}

void describe("filterStatuses", () => {
  const statuses = [
    makeStatus({ repoId: "my-repo" }),
    makeStatus({ repoId: "other-repo" }),
  ];

  void it("returns all when no search", () => {
    strictEqual(filterStatuses(statuses, "").length, 2);
  });

  void it("filters by repo ID", () => {
    const result = filterStatuses(statuses, "my-repo");
    strictEqual(result.length, 1);
    strictEqual(result[0].repoId, "my-repo");
  });

  void it("filters case-insensitively", () => {
    const result = filterStatuses(statuses, "MY-REPO");
    strictEqual(result.length, 1);
  });

  void it("returns empty for no match", () => {
    strictEqual(filterStatuses(statuses, "nope").length, 0);
  });
});

/* ------------------------------------------------------------------ */
/*  Repo ID intersection logic                                         */
/* ------------------------------------------------------------------ */

function intersectWithRepoIds(
  allStatuses: Record<string, GraphifyStatus>,
  repoIds: string[]
): GraphifyStatus[] {
  return repoIds
    .map((id) => allStatuses[id])
    .filter((s): s is GraphifyStatus => s !== undefined);
}

void describe("intersectWithRepoIds", () => {
  const allStatuses: Record<string, GraphifyStatus> = {
    a: makeStatus({ repoId: "a" }),
    b: makeStatus({ repoId: "b" }),
    c: makeStatus({ repoId: "c" }),
  };

  void it("returns matching statuses in order", () => {
    const result = intersectWithRepoIds(allStatuses, ["b", "a"]);
    strictEqual(result.length, 2);
    strictEqual(result[0].repoId, "b");
    strictEqual(result[1].repoId, "a");
  });

  void it("skips unknown repo IDs", () => {
    const result = intersectWithRepoIds(allStatuses, ["a", "unknown", "c"]);
    strictEqual(result.length, 2);
  });

  void it("returns empty when no overlap", () => {
    strictEqual(intersectWithRepoIds(allStatuses, ["x", "y"]).length, 0);
  });
});

/* ------------------------------------------------------------------ */
/*  hasGraphCount logic                                                */
/* ------------------------------------------------------------------ */

function countHasGraph(statuses: GraphifyStatus[]): number {
  return statuses.filter((s) => s.available || s.artifacts.graphJson).length;
}

void describe("countHasGraph", () => {
  void it("counts available repos", () => {
    const statuses = [
      makeStatus({ repoId: "a", available: true, artifacts: { graphJson: true, graphReport: true, wikiIndex: false, graphHtml: false, manifest: false } }),
    ];
    strictEqual(countHasGraph(statuses), 1);
  });

  void it("counts partial repos", () => {
    const statuses = [
      makeStatus({
        repoId: "p",
        available: false,
        artifacts: { graphJson: true, graphReport: false, wikiIndex: false, graphHtml: false, manifest: false },
      }),
    ];
    strictEqual(countHasGraph(statuses), 1);
  });

  void it("does not count absent repos", () => {
    const statuses = [makeStatus({ repoId: "x", available: false })];
    strictEqual(countHasGraph(statuses), 0);
  });
});
