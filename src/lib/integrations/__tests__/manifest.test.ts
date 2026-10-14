/**
 * Tests for the manifest builder — determinism, Graphify summary,
 * failure degradation, no exception leakage, bounds, state validation.
 *
 * Run: node --experimental-strip-types --loader ../../../scripts/register-ts.mjs \
 *       --test src/lib/integrations/__tests__/manifest.test.ts
 */

import { describe, it, before, after } from "node:test";
import { ok, strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { IntegrationRegistry } from "../registry";
import { buildManifest } from "../manifest";
import { BUILT_IN_PROVIDERS } from "../providers/index";
import type {
  IntegrationProvider,
  WorkspaceIntegrationContext,
} from "../types";

void describe("buildManifest", () => {
  const registry = IntegrationRegistry.create({
    providers: [...BUILT_IN_PROVIDERS],
  });

  const baseCtx: WorkspaceIntegrationContext = {
    workspaceFilePath: "/home/example/project.code-workspace",
    workspaceName: "project",
    repos: [
      { id: "repo-a", rootPath: "/home/example/repo-a", displayName: "repo-a" },
      { id: "repo-b", rootPath: "/home/example/repo-b", displayName: "repo-b" },
    ],
  };

  void it("produces a deterministic manifest", async () => {
    const m1 = await buildManifest(registry, baseCtx);
    const m2 = await buildManifest(registry, baseCtx);

    strictEqual(m1.workspaceName, m2.workspaceName);
    strictEqual(m1.providers.length, m2.providers.length);
    strictEqual(m1.providers[0].id, m2.providers[0].id);
    strictEqual(
      JSON.stringify(m1.providers.map((p) => p.id)),
      JSON.stringify(m2.providers.map((p) => p.id))
    );
  });

  void it("includes Graphify provider", async () => {
    const manifest = await buildManifest(registry, baseCtx);
    const graphify = manifest.providers.find((p) => p.id === "built-in-graphify");
    ok(graphify, "Graphify provider should be present");
    strictEqual(graphify.state, "available");
  });

  void it("Graphify shows repo count metrics", async () => {
    const manifest = await buildManifest(registry, baseCtx);
    const graphify = manifest.providers.find((p) => p.id === "built-in-graphify")!;

    // Should have graphify-summary block
    const summaryBlock = graphify.blocks.find((b) => b.id === "graphify-summary");
    ok(summaryBlock, "Should have graphify-summary block");
    strictEqual(summaryBlock.type, "metric-list");
  });

  void it("is bounded and does not expose paths", async () => {
    const manifest = await buildManifest(registry, baseCtx);

    for (const entry of manifest.providers) {
      // No raw paths in description
      ok(
        /^[a-zA-Z]/.test(entry.description),
        `Description "${entry.description}" should start with a letter`
      );

      // No exception strings
      if (entry.errorMessage) {
        ok(
          !entry.errorMessage.includes("Error:"),
          "No exception prefixes in error messages"
        );
        ok(
          !entry.errorMessage.includes("/home/"),
          "No paths in error messages"
        );
      }

      for (const block of entry.blocks) {
        // No raw file paths in block titles
        ok(
          !block.id.includes("/"),
          `Block id "${block.id}" must not contain paths`
        );
        ok(
          !block.title.includes("/home/"),
          `Block title "${block.title}" must not contain paths`
        );
      }
    }
  });

  void it("caps total provider entries at 20", async () => {
    // Create registry with 25 providers
    const manyProviders: IntegrationProvider[] = [];
    for (let i = 0; i < 25; i++) {
      manyProviders.push({
        id: `prov-${i}`,
        name: `Provider ${i}`,
        description: `Description ${i}`,
        capabilities: ["context"],
        riskLevel: "readonly",
        tools: [],
        getBlocks: () => [],
      });
    }

    const bigReg = IntegrationRegistry.create({ providers: manyProviders });
    const manifest = await buildManifest(bigReg, baseCtx);
    ok(
      manifest.providers.length <= 20,
      `Should cap at 20, got ${manifest.providers.length}`
    );
  });
});

void describe("Graphify summary with filesystem repositories", () => {
  let repoDir: string;
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dashboard-integrations-manifest-test-"));
    repoDir = resolve(tmpDir, "repo-with-graph");
    mkdirSync(repoDir, { recursive: true });

    // Create graphify-out with graph.json + wiki
    const out = join(repoDir, "graphify-out");
    mkdirSync(out, { recursive: true });
    mkdirSync(join(out, "wiki"), { recursive: true });
    writeFileSync(join(out, "graph.json"), JSON.stringify({ nodes: [], links: [] }));
    writeFileSync(join(out, "wiki", "index.md"), "# Wiki\nTest content");
    writeFileSync(join(out, "GRAPH_REPORT.md"), "# Report");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  void it("Graphify detects available graph", async () => {
    const registry = IntegrationRegistry.create({
      providers: [...BUILT_IN_PROVIDERS],
    });

    const ctx: WorkspaceIntegrationContext = {
      workspaceFilePath: resolve(tmpDir, "test.code-workspace"),
      workspaceName: "test",
      repos: [
        { id: "repo-1", rootPath: repoDir, displayName: "repo-with-graph" },
        {
          id: "repo-2",
          rootPath: resolve(tmpDir, "no-graph-repo"),
          displayName: "no-graph-repo",
        },
      ],
    };

    // Ensure second repo dir exists (even without graph)
    mkdirSync(resolve(tmpDir, "no-graph-repo"), { recursive: true });

    const manifest = await buildManifest(registry, ctx);
    const graphify = manifest.providers.find(
      (p) => p.id === "built-in-graphify"
    )!;

    strictEqual(graphify.state, "available");

    // Should have status-list showing repo statuses
    const statusBlock = graphify.blocks.find((b) => b.id === "graphify-repos");
    ok(statusBlock, "status list block present");

    // Metric summary should show counts
    const summaryBlock = graphify.blocks.find(
      (b) => b.id === "graphify-summary"
    );
    ok(summaryBlock, "summary block present");
    strictEqual(summaryBlock.type, "metric-list");
    if (summaryBlock.type === "metric-list") {
      const totalItem = summaryBlock.items.find((i) => i.label === "Total repos");
      ok(totalItem);
      strictEqual(totalItem.value, "2");
    }
  });
});

void describe("Failure degradation", () => {
  void it("degrades gracefully when provider throws", async () => {
    const failingProvider: IntegrationProvider = {
      id: "failing-provider",
      name: "Failing",
      description: "This provider throws",
      capabilities: ["diagnostics"],
      riskLevel: "readonly",
      tools: [],
      getBlocks: () => {
        throw new Error("Something went wrong");
      },
    };

    const registry = IntegrationRegistry.create({
      providers: [failingProvider],
    });

    const ctx: WorkspaceIntegrationContext = {
      workspaceFilePath: "/tmp/test.code-workspace",
      workspaceName: "test",
      repos: [{ id: "r1", rootPath: "/tmp/r1", displayName: "r1" }],
    };

    const manifest = await buildManifest(registry, ctx);
    const entry = manifest.providers[0];

    strictEqual(entry.state, "unavailable");
    ok(entry.errorCode, "Should have an error code");
    ok(
      !entry.errorMessage?.includes("Something went wrong"),
      "Must not leak exception strings"
    );
    ok(!entry.errorMessage?.includes("/tmp/"), "Must not leak paths");
  });

  void it("degrades gracefully when provider.getState returns unavailable", async () => {
    const unavailableProvider: IntegrationProvider = {
      id: "unavail",
      name: "Unavailable",
      description: "Not available",
      capabilities: ["context"],
      riskLevel: "readonly",
      tools: [],
      getBlocks: () => [],
      getState: () => "unavailable",
    };

    const registry = IntegrationRegistry.create({
      providers: [unavailableProvider],
    });

    const ctx: WorkspaceIntegrationContext = {
      workspaceFilePath: "/tmp/test.code-workspace",
      workspaceName: "test",
      repos: [],
    };

    const manifest = await buildManifest(registry, ctx);
    const entry = manifest.providers[0];

    strictEqual(entry.state, "unavailable");
    strictEqual(entry.errorCode, "PROVIDER_UNAVAILABLE");
  });

  void it("treats invalid getState return as provider failure", async () => {
    const badProvider: IntegrationProvider = {
      id: "bad-state",
      name: "Bad State",
      description: "Returns invalid state",
      capabilities: ["context"],
      riskLevel: "readonly",
      tools: [],
      getBlocks: () => [],
      getState: () => "nonsense" as never,
    };

    const registry = IntegrationRegistry.create({
      providers: [badProvider],
    });

    const ctx: WorkspaceIntegrationContext = {
      workspaceFilePath: "/tmp/test.code-workspace",
      workspaceName: "test",
      repos: [{ id: "r1", rootPath: "/tmp/r1", displayName: "r1" }],
    };

    const manifest = await buildManifest(registry, ctx);
    const entry = manifest.providers[0];

    strictEqual(entry.state, "unavailable");
    // Must not be substring-matched — should be UNEXPECTED_ERROR via provider failure
    ok(entry.errorCode, "Should have an error code");
    ok(
      !entry.errorMessage?.includes("nonsense"),
      "Must not leak invalid value"
    );
  });

  void it("keeps thrown-provider tool descriptors bounded", async () => {
    const failingProvider: IntegrationProvider = {
      id: "failing-with-tool",
      name: "Failing with tool",
      description: "Throws after registering maximum-length tool metadata",
      capabilities: ["context"],
      riskLevel: "readonly",
      tools: [
        {
          id: "a".repeat(80),
          label: "x".repeat(120),
          description: "y".repeat(300),
          requiresApproval: false,
          risk: "readonly",
        },
      ],
      getBlocks: () => {
        throw new Error("boom");
      },
    };

    const registry = IntegrationRegistry.create({
      providers: [failingProvider],
    });

    const ctx: WorkspaceIntegrationContext = {
      workspaceFilePath: "/tmp/test.code-workspace",
      workspaceName: "test",
      repos: [{ id: "r1", rootPath: "/tmp/r1", displayName: "r1" }],
    };

    const manifest = await buildManifest(registry, ctx);
    const entry = manifest.providers[0];

    strictEqual(entry.state, "unavailable");
    ok(entry.errorCode, "Should have an error code");
    strictEqual(entry.tools[0].id.length, 80);
    strictEqual(entry.tools[0].label.length, 120);
    strictEqual(entry.tools[0].description.length, 300);
  });

  void it("degraded entry has safe error code union including degraded", async () => {
    const degradingProvider: IntegrationProvider = {
      id: "degrading-provider",
      name: "Degrading",
      description: "Returns degraded",
      capabilities: ["context"],
      riskLevel: "readonly",
      tools: [],
      getBlocks: () => [],
      getState: () => "degraded",
    };

    const registry = IntegrationRegistry.create({
      providers: [degradingProvider],
    });

    const ctx: WorkspaceIntegrationContext = {
      workspaceFilePath: "/tmp/test.code-workspace",
      workspaceName: "test",
      repos: [{ id: "r1", rootPath: "/tmp/r1", displayName: "r1" }],
    };

    const manifest = await buildManifest(registry, ctx);
    const entry = manifest.providers[0];

    strictEqual(entry.state, "degraded");
    strictEqual(entry.errorCode, "PROVIDER_DEGRADED");
  });
});
