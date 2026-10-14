/**
 * Tests for Graphify lazy read-only operations.
 * Run: node --experimental-strip-types --loader ../../scripts/register-ts.mjs \
 *       --test src/lib/graphify/__tests__/operations.test.ts
 */

import { describe, it, before, after } from "node:test";
import { ok, strictEqual } from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  getGraphMeta,
  getGraphHtmlUrl,
  getWikiSnippet,
  getLazyOpAvailability,
} from "../operations";
import type { GraphifyArtifacts } from "../types";

const TMP = resolve(tmpdir(), "dashboard-graphify-ops-test");

function setupGraphifyOut(dir: string, sub: string): string {
  const out = join(dir, "graphify-out");
  mkdirSync(out, { recursive: true });
  return out;
}

void describe("getGraphMeta", () => {
  let repoDir: string;

  before(() => {
    rmSync(TMP, { recursive: true, force: true });
    repoDir = resolve(TMP, "meta-test");
    mkdirSync(repoDir, { recursive: true });
  });

  after(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  void it("returns null when no graph.json", () => {
    strictEqual(getGraphMeta(repoDir), null);
  });

  void it("returns metadata from graph.json", () => {
    const out = setupGraphifyOut(repoDir, "");
    const graph = {
      nodes: [
        { id: "a", community: 0 },
        { id: "b", community: 0 },
        { id: "c", community: 1 },
      ],
      links: [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
    };
    writeFileSync(join(out, "graph.json"), JSON.stringify(graph));

    const meta = getGraphMeta(repoDir);
    ok(meta !== null);
    strictEqual(meta.nodeCount, 3);
    strictEqual(meta.linkCount, 2);
    strictEqual(meta.communityCount, 2);
    ok(meta.sizeBytes > 0);
  });

  void it("returns null for malformed JSON", () => {
    const out = setupGraphifyOut(repoDir, "");
    writeFileSync(join(out, "graph.json"), "not json");

    strictEqual(getGraphMeta(repoDir), null);
  });

  void it("returns null when nodes/links are not arrays", () => {
    const out = setupGraphifyOut(repoDir, "");
    writeFileSync(join(out, "graph.json"), JSON.stringify({ nodes: "bad", links: "bad" }));

    strictEqual(getGraphMeta(repoDir), null);
  });

  void it("handles empty graph", () => {
    const out = setupGraphifyOut(repoDir, "");
    writeFileSync(join(out, "graph.json"), JSON.stringify({ nodes: [], links: [] }));

    const meta = getGraphMeta(repoDir);
    ok(meta !== null);
    strictEqual(meta.nodeCount, 0);
    strictEqual(meta.linkCount, 0);
    strictEqual(meta.communityCount, null);
  });
});

void describe("getGraphHtmlUrl", () => {
  let repoDir: string;

  before(() => {
    repoDir = resolve(TMP, "html-test");
    mkdirSync(repoDir, { recursive: true });
  });

  after(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  void it("returns null when no graph.html", () => {
    strictEqual(getGraphHtmlUrl(repoDir), null);
  });

  void it("returns file:// URI when graph.html exists", () => {
    setupGraphifyOut(repoDir, "");
    writeFileSync(join(repoDir, "graphify-out", "graph.html"), "<html></html>");

    const url = getGraphHtmlUrl(repoDir);
    ok(url !== null);
    ok(url.startsWith("file://"));
    ok(url.includes("graph.html"));
  });
});

void describe("getWikiSnippet", () => {
  let repoDir: string;

  before(() => {
    repoDir = resolve(TMP, "wiki-test");
    mkdirSync(repoDir, { recursive: true });
  });

  after(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  void it("returns null when no wiki/index.md", () => {
    strictEqual(getWikiSnippet(repoDir), null);
  });

  void it("returns capped content from wiki/index.md", () => {
    const wiki = join(repoDir, "graphify-out", "wiki");
    mkdirSync(wiki, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) lines.push(`Line ${i + 1}`);
    writeFileSync(join(wiki, "index.md"), lines.join("\n"));

    const snippet = getWikiSnippet(repoDir, 10);
    ok(snippet !== null);
    const snippetLines = snippet.split("\n");
    strictEqual(snippetLines.length, 10);
    strictEqual(snippetLines[0], "Line 1");
    strictEqual(snippetLines[9], "Line 10");
  });

  void it("returns full content when shorter than maxLines", () => {
    const wiki = join(repoDir, "graphify-out", "wiki");
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, "index.md"), "Short content");

    const snippet = getWikiSnippet(repoDir, 50);
    ok(snippet !== null);
    strictEqual(snippet.trim(), "Short content");
  });
});

void describe("getLazyOpAvailability", () => {
  void it("reports all false when no artifacts", () => {
    const a: GraphifyArtifacts = {
      graphJson: false,
      wikiIndex: false,
      graphReport: false,
      graphHtml: false,
      manifest: false,
    };
    const avail = getLazyOpAvailability(a);
    strictEqual(avail.meta, false);
    strictEqual(avail.openHtml, false);
    strictEqual(avail.wiki, false);
  });

  void it("reports meta when graphJson present", () => {
    const a: GraphifyArtifacts = {
      graphJson: true,
      wikiIndex: false,
      graphReport: false,
      graphHtml: false,
      manifest: false,
    };
    const avail = getLazyOpAvailability(a);
    strictEqual(avail.meta, true);
    strictEqual(avail.openHtml, false);
    strictEqual(avail.wiki, false);
  });

  void it("reports openHtml when graphHtml present", () => {
    const a: GraphifyArtifacts = {
      graphJson: false,
      wikiIndex: false,
      graphReport: false,
      graphHtml: true,
      manifest: false,
    };
    const avail = getLazyOpAvailability(a);
    strictEqual(avail.meta, false);
    strictEqual(avail.openHtml, true);
  });

  void it("reports wiki when wikiIndex present", () => {
    const a: GraphifyArtifacts = {
      graphJson: false,
      wikiIndex: true,
      graphReport: false,
      graphHtml: false,
      manifest: false,
    };
    const avail = getLazyOpAvailability(a);
    strictEqual(avail.meta, false);
    strictEqual(avail.wiki, true);
  });
});
