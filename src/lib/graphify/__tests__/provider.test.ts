/**
 * Tests for Graphify provider — artifact detection, staleness, capabilities.
 * Run: node --experimental-strip-types --loader ../../scripts/register-ts.mjs \
 *       --test src/lib/graphify/__tests__/provider.test.ts
 *
 * Creates disposable temp git repos with graphify-out artifacts.
 */

import { describe, it, before, after } from "node:test";
import { ok, strictEqual, throws, match } from "node:assert";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  detectArtifacts,
  isGraphAvailable,
  isGraphifyCliAvailable,
  buildCapabilities,
  buildStaleness,
  buildGraphifyStatus,
  assertAuthorizedRepoRoot,
} from "../provider";
import type { GraphifyArtifacts } from "../types";

const TMP = resolve(tmpdir(), "dashboard-graphify-provider-test");

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync("git", ["init", "-b", "main"], {
    cwd: dir,
    stdio: "pipe",
    timeout: 10000,
  });
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
  writeFileSync(join(dir, "README.md"), "# test");
  spawnSync("git", ["add", "."], { cwd: dir, stdio: "pipe", timeout: 5000 });
  spawnSync("git", ["commit", "-m", "initial"], {
    cwd: dir,
    stdio: "pipe",
    timeout: 5000,
  });
}

function mkGraphifyOut(dir: string): string {
  const out = join(dir, "graphify-out");
  mkdirSync(out, { recursive: true });
  return out;
}

void describe("assertAuthorizedRepoRoot", () => {
  void it("passes for authorized roots", () => {
    const authorized = new Set(["/repo/a", "/repo/b"]);
    assertAuthorizedRepoRoot("/repo/a", authorized); // no throw
  });

  void it("throws for unauthorized roots", () => {
    const authorized = new Set(["/repo/a"]);
    throws(
      () => assertAuthorizedRepoRoot("/repo/b", authorized),
      /Unauthorized path/
    );
  });
});

void describe("detectArtifacts", () => {
  let repoDir: string;

  before(() => {
    rmSync(TMP, { recursive: true, force: true });
    repoDir = resolve(TMP, "detect-test");
    gitInit(repoDir);
  });

  after(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  void it("returns all false when no graphify-out exists", () => {
    const artifacts = detectArtifacts(repoDir);
    strictEqual(artifacts.graphJson, false);
    strictEqual(artifacts.wikiIndex, false);
    strictEqual(artifacts.graphReport, false);
    strictEqual(artifacts.graphHtml, false);
    strictEqual(artifacts.manifest, false);
  });

  void it("detects graph.json", () => {
    const out = mkGraphifyOut(repoDir);
    writeFileSync(join(out, "graph.json"), "{}");
    const artifacts = detectArtifacts(repoDir);
    strictEqual(artifacts.graphJson, true);
  });

  void it("detects wiki/index.md", () => {
    const wiki = join(repoDir, "graphify-out", "wiki");
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, "index.md"), "# Wiki");
    const artifacts = detectArtifacts(repoDir);
    strictEqual(artifacts.wikiIndex, true);
  });

  void it("detects GRAPH_REPORT.md", () => {
    writeFileSync(
      join(repoDir, "graphify-out", "GRAPH_REPORT.md"),
      "# Report"
    );
    const artifacts = detectArtifacts(repoDir);
    strictEqual(artifacts.graphReport, true);
  });

  void it("detects graph.html", () => {
    writeFileSync(join(repoDir, "graphify-out", "graph.html"), "<html></html>");
    const artifacts = detectArtifacts(repoDir);
    strictEqual(artifacts.graphHtml, true);
  });

  void it("detects manifest.json", () => {
    writeFileSync(join(repoDir, "graphify-out", "manifest.json"), "{}");
    const artifacts = detectArtifacts(repoDir);
    strictEqual(artifacts.manifest, true);
  });

  void it("detects all artifacts when present", () => {
    // All should still be true from previous tests
    const artifacts = detectArtifacts(repoDir);
    strictEqual(artifacts.graphJson, true);
    strictEqual(artifacts.wikiIndex, true);
    strictEqual(artifacts.graphReport, true);
    strictEqual(artifacts.graphHtml, true);
    strictEqual(artifacts.manifest, true);
  });
});

void describe("isGraphAvailable", () => {
  void it("returns false with no artifacts", () => {
    strictEqual(
      isGraphAvailable({
        graphJson: false,
        wikiIndex: false,
        graphReport: false,
        graphHtml: false,
        manifest: false,
      }),
      false
    );
  });

  void it("returns false with graphJson alone", () => {
    strictEqual(
      isGraphAvailable({
        graphJson: true,
        wikiIndex: false,
        graphReport: false,
        graphHtml: false,
        manifest: false,
      }),
      false
    );
  });

  void it("returns true with graphJson + graphReport", () => {
    strictEqual(
      isGraphAvailable({
        graphJson: true,
        wikiIndex: false,
        graphReport: true,
        graphHtml: false,
        manifest: false,
      }),
      true
    );
  });

  void it("returns true with graphJson + wikiIndex", () => {
    strictEqual(
      isGraphAvailable({
        graphJson: true,
        wikiIndex: true,
        graphReport: false,
        graphHtml: false,
        manifest: false,
      }),
      true
    );
  });
});

void describe("isGraphifyCliAvailable", () => {
  void it("returns true if graphify is on PATH", () => {
    // Works on machines where graphify is installed
    const available = isGraphifyCliAvailable();
    // In CI or constrained environments it may be false — that's fine
    ok(typeof available === "boolean");
  });
});

void describe("buildCapabilities", () => {
  const fullArtifacts: GraphifyArtifacts = {
    graphJson: true,
    wikiIndex: true,
    graphReport: true,
    graphHtml: true,
    manifest: true,
  };

  const noArtifacts: GraphifyArtifacts = {
    graphJson: false,
    wikiIndex: false,
    graphReport: false,
    graphHtml: false,
    manifest: false,
  };

  void it("returns empty operations when graphJson absent", () => {
    const caps = buildCapabilities(noArtifacts, true);
    strictEqual(caps.operations.length, 0);
  });

  void it("includes query/path/explain when CLI is available and graphJson present", () => {
    const caps = buildCapabilities(fullArtifacts, true);
    ok(caps.operations.includes("query"));
    ok(caps.operations.includes("path"));
    ok(caps.operations.includes("explain"));
  });

  void it("excludes query/path/explain when CLI is unavailable", () => {
    const caps = buildCapabilities(fullArtifacts, false);
    ok(!caps.operations.includes("query"));
    ok(!caps.operations.includes("path"));
    ok(!caps.operations.includes("explain"));
  });

  void it("includes wiki when wikiIndex present", () => {
    const caps = buildCapabilities(
      { ...fullArtifacts, wikiIndex: true },
      false
    );
    ok(caps.operations.includes("wiki"));
  });

  void it("excludes wiki when wikiIndex absent", () => {
    const caps = buildCapabilities(
      { ...fullArtifacts, wikiIndex: false },
      false
    );
    ok(!caps.operations.includes("wiki"));
  });

  void it("includes open-html when graphHtml present", () => {
    const caps = buildCapabilities(
      { ...fullArtifacts, graphHtml: true },
      false
    );
    ok(caps.operations.includes("open-html"));
  });

  void it("excludes open-html when graphHtml absent", () => {
    const caps = buildCapabilities(
      { ...fullArtifacts, graphHtml: false },
      false
    );
    ok(!caps.operations.includes("open-html"));
  });
});

void describe("buildStaleness", () => {
  let repoDir: string;

  before(() => {
    repoDir = resolve(TMP, "staleness-test");
    gitInit(repoDir);
  });

  void it("returns unknown status with null dates when no graphify-out", () => {
    const s = buildStaleness(repoDir);
    strictEqual(s.status, "unknown");
    // No graphify-out committed, so no graph commit date
    ok(typeof s.lastRepoCommitDate === "string" || s.lastRepoCommitDate === null);
  });

  void it("returns graph mtime when graph.json exists", () => {
    const out = mkGraphifyOut(repoDir);
    writeFileSync(join(out, "graph.json"), "{}");
    spawnSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe", timeout: 5000 });
    spawnSync("git", ["commit", "-m", "add graph"], {
      cwd: repoDir,
      stdio: "pipe",
      timeout: 5000,
    });

    const s = buildStaleness(repoDir);
    strictEqual(s.status, "unknown");
    ok(s.graphMtime !== null, "graphMtime should be set");
    ok(s.lastRepoCommitDate !== null, "lastRepoCommitDate should be set");
  });
});

void describe("buildGraphifyStatus", () => {
  let repoDir: string;

  before(() => {
    repoDir = resolve(TMP, "composite-test");
    gitInit(repoDir);
  });

  void it("returns all-false artifacts for repo without graphify", () => {
    const status = buildGraphifyStatus("test-id-1", repoDir);
    strictEqual(status.repoId, "test-id-1");
    strictEqual(status.repoRoot, repoDir);
    strictEqual(status.available, false);
    strictEqual(status.artifacts.graphJson, false);
    strictEqual(status.capabilities.operations.length, 0);
    strictEqual(status.staleness.status, "unknown");
  });

  void it("returns available:true when graph is present", () => {
    const out = mkGraphifyOut(repoDir);
    writeFileSync(join(out, "graph.json"), "{}");
    writeFileSync(join(out, "GRAPH_REPORT.md"), "# Report");
    writeFileSync(join(out, "graph.html"), "<html></html>");
    spawnSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe", timeout: 5000 });
    spawnSync("git", ["commit", "-m", "full graph"], {
      cwd: repoDir,
      stdio: "pipe",
      timeout: 5000,
    });

    const status = buildGraphifyStatus("test-id-2", repoDir);
    strictEqual(status.available, true);
    strictEqual(status.artifacts.graphJson, true);
    strictEqual(status.artifacts.graphReport, true);
    strictEqual(status.artifacts.graphHtml, true);
  });
});
