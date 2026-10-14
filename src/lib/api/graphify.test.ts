/**
 * Tests for Graphify client API layer.
 *
 * Run: node --experimental-strip-types --loader ../../scripts/register-ts.mjs \
 *       --test src/lib/api/graphify.test.ts
 *
 * These test the URL construction and response parsing logic by
 * mocking global fetch.  No actual server is needed.
 */

import { describe, it, mock } from "node:test";
import { strictEqual, ok, rejects } from "node:assert";
import {
  fetchGraphifyStatus,
  fetchGraphifyStatusForRepo,
  fetchGraphMeta,
  fetchGraphHtmlUrl,
  fetchWikiSnippet,
} from "./graphify";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Create a mock fetch that returns the given JSON body + status */
function mockFetch(
  body: unknown,
  status = 200
): ReturnType<typeof mock.fn> {
  return mock.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    )
  );
}

/* ------------------------------------------------------------------ */
/*  fetchGraphifyStatus                                                */
/* ------------------------------------------------------------------ */

void describe("fetchGraphifyStatus", () => {
  void it("sends GET to /api/graphify with encoded workspace path", async () => {
    const fn = mockFetch({ repos: {}, errors: [] });
    global.fetch = fn;

    const result = await fetchGraphifyStatus("/path/to/test.code-workspace");

    strictEqual(fn.mock.callCount(), 1);
    const url = fn.mock.calls[0].arguments[0] as string;
    ok(url.includes("/api/graphify"));
    ok(url.includes("workspace="));
    ok(url.includes(encodeURIComponent("/path/to/test.code-workspace")));
    strictEqual(result.errors.length, 0);
  });

  void it("throws on non-200 response", async () => {
    global.fetch = mockFn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Bad workspace" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    await rejects(
      () => fetchGraphifyStatus("/bad/path"),
      /Bad workspace/
    );
  });
});

/* ------------------------------------------------------------------ */
/*  fetchGraphifyStatusForRepo                                         */
/* ------------------------------------------------------------------ */

void describe("fetchGraphifyStatusForRepo", () => {
  void it("returns null for unknown repo ID", async () => {
    global.fetch = mockFetch({ repos: {}, errors: [] });
    const result = await fetchGraphifyStatusForRepo("/ws", "unknown-id");
    strictEqual(result, null);
  });

  void it("returns status for a known repo ID", async () => {
    const mockStatus = {
      repoId: "my-repo",
      repoRoot: "/repos/my-repo",
      graphifyCliAvailable: true,
      artifacts: {
        graphJson: true,
        wikiIndex: true,
        graphReport: true,
        graphHtml: false,
        manifest: false,
      },
      available: true,
      staleness: { status: "unknown" as const, lastGraphCommitDate: null, lastRepoCommitDate: null, graphMtime: null },
      capabilities: { operations: ["wiki" as const] },
    };
    global.fetch = mockFetch({
      repos: { "my-repo": mockStatus },
      errors: [],
    });

    const result = await fetchGraphifyStatusForRepo("/ws", "my-repo");
    ok(result !== null);
    strictEqual(result.repoId, "my-repo");
    strictEqual(result.available, true);
  });
});

/* ------------------------------------------------------------------ */
/*  Lazy operations                                                    */
/* ------------------------------------------------------------------ */

void describe("fetchGraphMeta", () => {
  void it("sends GET with op=meta", async () => {
    const fn = mockFetch({ repoId: "r", meta: { nodeCount: 10, linkCount: 5, communityCount: 2, sizeBytes: 1000 } });
    global.fetch = fn;

    const result = await fetchGraphMeta("r");
    strictEqual(result.repoId, "r");
    strictEqual(result.meta.nodeCount, 10);
    const url = fn.mock.calls[0].arguments[0] as string;
    ok(url.includes("op=meta"));
  });
});

void describe("fetchGraphHtmlUrl", () => {
  void it("sends GET with op=open-html", async () => {
    const fn = mockFetch({ repoId: "r", url: "file:///graph.html" });
    global.fetch = fn;

    const result = await fetchGraphHtmlUrl("r");
    strictEqual(result.url, "file:///graph.html");
    const url = fn.mock.calls[0].arguments[0] as string;
    ok(url.includes("op=open-html"));
  });
});

void describe("fetchWikiSnippet", () => {
  void it("sends GET with op=wiki", async () => {
    const fn = mockFetch({ repoId: "r", snippet: "# Wiki" });
    global.fetch = fn;

    const result = await fetchWikiSnippet("r");
    strictEqual(result.snippet, "# Wiki");
    const url = fn.mock.calls[0].arguments[0] as string;
    ok(url.includes("op=wiki"));
  });
});

/* ------------------------------------------------------------------ */
/*  Edge cases                                                         */
/* ------------------------------------------------------------------ */

void describe("error handling", () => {
  void it("throws on network error", async () => {
    global.fetch = mock.fn(() => Promise.reject(new Error("Network failure")));

    await rejects(
      () => fetchGraphifyStatus("/ws"),
      /Network failure/
    );
  });

  void it("handles non-JSON error responses", async () => {
    global.fetch = mock.fn(() =>
      Promise.resolve(
        new Response("Internal Server Error", { status: 500 })
      )
    );

    await rejects(
      () => fetchGraphifyStatus("/ws"),
      /API error 500/
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Helpers (local, avoids extra mock.fn import)                       */
/* ------------------------------------------------------------------ */

function mockFn(impl: (...args: unknown[]) => unknown) {
  return mock.fn(impl);
}
