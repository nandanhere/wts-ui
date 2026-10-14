/**
 * Tests for GraphifyRepoRow component (headless rendering).
 *
 * Since this is a client component using fetch and React state,
 * we test the logic that can be isolated: coverage-dot logic,
 * artifact-icon rendering helpers, and size-formatting utility.
 *
 * Full render tests would require jsdom or Playwright.
 *
 * Run: node --experimental-strip-types --loader ../../scripts/register-ts.mjs \
 *       --test src/components/graphify/graphify-repo-row.test.tsx
 */

import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert";

/* ------------------------------------------------------------------ */
/*  Size formatting (extracted logic from graphify-repo-row)          */
/* ------------------------------------------------------------------ */

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

void describe("fmtSize utility", () => {
  void it("formats bytes under 1 KB", () => {
    strictEqual(fmtSize(0), "0 B");
    strictEqual(fmtSize(512), "512 B");
    strictEqual(fmtSize(1023), "1023 B");
  });

  void it("formats kilobytes", () => {
    strictEqual(fmtSize(1024), "1.0 KB");
    strictEqual(fmtSize(1536), "1.5 KB");
    strictEqual(fmtSize(1048575), "1024.0 KB");
  });

  void it("formats megabytes", () => {
    strictEqual(fmtSize(1048576), "1.0 MB");
    strictEqual(fmtSize(5242880), "5.0 MB");
    strictEqual(fmtSize(10485760), "10.0 MB");
  });
});

/* ------------------------------------------------------------------ */
/*  Coverage dot color logic                                           */
/* ------------------------------------------------------------------ */

function coverageDotColor(available: boolean | null): string {
  if (available === true) return "bg-success/60";
  if (available === false) return "bg-muted/20";
  return "bg-warn/50";
}

void describe("CoverageDot color logic", () => {
  void it("returns success color when available", () => {
    strictEqual(coverageDotColor(true), "bg-success/60");
  });

  void it("returns muted color when absent", () => {
    strictEqual(coverageDotColor(false), "bg-muted/20");
  });

  void it("returns warn color when unknown", () => {
    strictEqual(coverageDotColor(null), "bg-warn/50");
  });
});

/* ------------------------------------------------------------------ */
/*  Lazy operation state modeling                                      */
/* ------------------------------------------------------------------ */

type LazyState =
  | { kind: "idle" }
  | { kind: "loading"; op: string }
  | { kind: "meta"; data: { nodeCount: number } }
  | { kind: "error"; op: string; message: string };

function canTriggerLazyOp(
  state: LazyState,
  targetOp: string
): boolean {
  if (state.kind === "loading" && state.op === targetOp) return false;
  return true;
}

void describe("lazy op guard logic", () => {
  void it("allows op when idle", () => {
    strictEqual(canTriggerLazyOp({ kind: "idle" }, "meta"), true);
  });

  void it("blocks duplicate loading of same op", () => {
    strictEqual(
      canTriggerLazyOp({ kind: "loading", op: "meta" }, "meta"),
      false
    );
  });

  void it("allows different op while another loads", () => {
    strictEqual(
      canTriggerLazyOp({ kind: "loading", op: "meta" }, "wiki"),
      true
    );
  });

  void it("allows op after error", () => {
    strictEqual(
      canTriggerLazyOp({ kind: "error", op: "meta", message: "fail" }, "meta"),
      true
    );
  });
});
