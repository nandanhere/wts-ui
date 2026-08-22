/**
 * Tests for the client-side deployment readiness API helpers.
 *
 * Tests are pure-function only — no HTTP mocking needed.
 *
 * Run: node --experimental-strip-types --loader ../../../scripts/register-ts.mjs \
 *       --test src/lib/api/__tests__/deployments.test.ts
 */

import { describe, it } from "node:test";
import { strictEqual, deepStrictEqual } from "node:assert";
import type { ConfigInventoryResult, ConfigFileMetadata } from "@/lib/config-inventory/types";
import {
  shortenFingerprint,
  summarizeRepoResult,
  aggregateDeploymentsView,
  groupFilesByKind,
} from "@/lib/api/deployments";

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

function makeFile(overrides: Partial<ConfigFileMetadata> = {}): ConfigFileMetadata {
  return {
    repoId: "repo-a",
    workspaceRelativePath: "workspace/config.yaml",
    repoRelativePath: "config.yaml",
    kind: "yaml",
    size: 100,
    mtime: "2026-07-01T00:00:00.000Z",
    fingerprint: "a".repeat(64),
    probableSecret: false,
    deploymentRelevance: 0.5,
    likelyEnvironments: [],
    ...overrides,
  };
}

function makeResult(
  repoId: string,
  files: ConfigFileMetadata[],
  overrides: Partial<ConfigInventoryResult> = {},
): ConfigInventoryResult {
  return {
    repoId,
    repoRootPath: `/tmp/repos/${repoId}`,
    files,
    truncated: false,
    scanTimeMs: 42,
    errors: [],
    limits: {
      maxDepth: 8,
      maxFiles: 100,
      maxFileBytes: 256 * 1024,
      totalBytes: 10 * 1024 * 1024,
    },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  shortenFingerprint                                                 */
/* ------------------------------------------------------------------ */

void describe("shortenFingerprint", () => {
  void it("shortens a 64-char hex fingerprint to 8 chars + ellipsis", () => {
    const fp = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    strictEqual(shortenFingerprint(fp), "abcdef12…");
  });

  void it("returns the original string when shorter than 8 chars", () => {
    strictEqual(shortenFingerprint("abc"), "abc");
    strictEqual(shortenFingerprint(""), "");
  });

  void it("returns the original string when null-like", () => {
    strictEqual(shortenFingerprint(""), "");
  });
});

/* ------------------------------------------------------------------ */
/*  summarizeRepoResult                                                */
/* ------------------------------------------------------------------ */

void describe("summarizeRepoResult", () => {
  void it("counts total files and high-relevance files", () => {
    const files = [
      makeFile({ repoRelativePath: "a.yaml", deploymentRelevance: 0.9 }),
      makeFile({ repoRelativePath: "b.yaml", deploymentRelevance: 0.7 }),
      makeFile({ repoRelativePath: "c.yaml", deploymentRelevance: 0.3 }),
    ];
    const result = makeResult("repo-a", files);
    const summary = summarizeRepoResult(result, "my-repo");

    strictEqual(summary.totalFiles, 3);
    strictEqual(summary.highRelevanceFiles, 2); // 0.9 and 0.7
  });

  void it("collects probable secret file names", () => {
    const files = [
      makeFile({ repoRelativePath: "config.yaml", probableSecret: false }),
      makeFile({ repoRelativePath: "secrets.yaml", probableSecret: true }),
      makeFile({ repoRelativePath: ".env", probableSecret: true }),
    ];
    const result = makeResult("repo-b", files);
    const summary = summarizeRepoResult(result, "secret-repo");

    deepStrictEqual(summary.secretFiles, ["secrets.yaml", ".env"]);
  });

  void it("collects unique sorted environments", () => {
    const files = [
      makeFile({ repoRelativePath: "values.prod.yaml", likelyEnvironments: ["production"] }),
      makeFile({ repoRelativePath: "values.staging.yaml", likelyEnvironments: ["staging"] }),
      makeFile({ repoRelativePath: "config.yaml", likelyEnvironments: ["production", "staging"] }),
    ];
    const result = makeResult("repo-c", files);
    const summary = summarizeRepoResult(result, "env-repo");

    deepStrictEqual(summary.environments, ["production", "staging"]);
  });

  void it("passes through truncation and errors", () => {
    const result = makeResult("repo-d", [], {
      truncated: true,
      errors: ["Permission denied: secrets/"],
    });
    const summary = summarizeRepoResult(result, "error-repo");

    strictEqual(summary.truncated, true);
    deepStrictEqual(summary.errors, ["Permission denied: secrets/"]);
  });

  void it("uses displayName from argument", () => {
    const result = makeResult("repo-e", []);
    const summary = summarizeRepoResult(result, "My Display Name");
    strictEqual(summary.displayName, "My Display Name");
  });
});

/* ------------------------------------------------------------------ */
/*  aggregateDeploymentsView                                           */
/* ------------------------------------------------------------------ */

void describe("aggregateDeploymentsView", () => {
  void it("aggregates multiple repos correctly", () => {
    const filesA = [
      makeFile({ repoRelativePath: "docker-compose.yaml", deploymentRelevance: 0.9, kind: "docker-compose" }),
    ];
    const filesB = [
      makeFile({ repoRelativePath: "secret.yaml", repoId: "repo-b", probableSecret: true, deploymentRelevance: 0.5 }),
      makeFile({ repoRelativePath: ".env.prod", repoId: "repo-b", probableSecret: true, likelyEnvironments: ["production"] }),
    ];

    const results = [
      makeResult("repo-a", filesA),
      makeResult("repo-b", filesB),
    ];

    const displayMap = { "repo-a": "Repo A", "repo-b": "Repo B" };
    const view = aggregateDeploymentsView(results, displayMap, []);

    strictEqual(view.totalConfigFiles, 3);
    strictEqual(view.totalHighRelevance, 1);
    strictEqual(view.totalSecretFiles, 2);
    deepStrictEqual(view.allEnvironments, ["production"]);
    strictEqual(view.anyTruncated, false);
    strictEqual(view.anyErrors, false);
    strictEqual(view.unknownRepoIds.length, 0);
  });

  void it("reports truncation and errors", () => {
    const result = makeResult("repo-a", [makeFile()], {
      truncated: true,
      errors: ["Scan timeout"],
    });
    const view = aggregateDeploymentsView([result], { "repo-a": "A" }, []);

    strictEqual(view.anyTruncated, true);
    strictEqual(view.anyErrors, true);
  });

  void it("handles empty results", () => {
    const view = aggregateDeploymentsView([], {}, ["repo-x", "repo-y"]);

    strictEqual(view.totalConfigFiles, 0);
    strictEqual(view.totalHighRelevance, 0);
    strictEqual(view.totalSecretFiles, 0);
    deepStrictEqual(view.allEnvironments, []);
    strictEqual(view.anyTruncated, false);
    strictEqual(view.anyErrors, false);
    deepStrictEqual(view.unknownRepoIds, ["repo-x", "repo-y"]);
  });
});

/* ------------------------------------------------------------------ */
/*  groupFilesByKind                                                   */
/* ------------------------------------------------------------------ */

void describe("groupFilesByKind", () => {
  void it("groups by kind sorted by count descending", () => {
    const files = [
      makeFile({ kind: "yaml" }),
      makeFile({ kind: "yaml" }),
      makeFile({ kind: "yaml" }),
      makeFile({ kind: "json" }),
      makeFile({ kind: "json" }),
      makeFile({ kind: "docker-compose" }),
    ];
    const groups = groupFilesByKind(files);

    deepStrictEqual(groups, [
      { kind: "yaml", count: 3 },
      { kind: "json", count: 2 },
      { kind: "docker-compose", count: 1 },
    ]);
  });

  void it("returns empty array for empty input", () => {
    deepStrictEqual(groupFilesByKind([]), []);
  });
});
