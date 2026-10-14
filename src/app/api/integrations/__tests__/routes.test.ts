/**
 * Tests for the integrations API route handler logic.
 *
 * Tests the server-side logic via handleIntegrationsGet with dependency injection,
 * covering: cross-origin 403, no workspace 409, no repos 409,
 * success authoritative context and provider data, and catch 500 with
 * no raw exception/path detail.
 *
 * Does not import next/server (not available in plain Node.js).
 *
 * Run: node --experimental-strip-types --loader ../../../../scripts/register-ts.mjs \
 *       --test src/app/api/integrations/__tests__/routes.test.ts
 */

import { describe, it } from "node:test";
import { ok, strictEqual } from "node:assert";

import { handleIntegrationsGet } from "@/lib/integrations/handler";
import type { RouteDeps } from "@/lib/integrations/handler";
import type { IntegrationRegistry } from "@/lib/integrations/registry";
import type { WorkspaceManifest } from "@/lib/integrations/types";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeRequest(origin?: string, host = "localhost:3000") {
  const headers = new Map<string, string>();
  headers.set("host", host);
  if (origin) headers.set("origin", origin);
  return {
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
    },
  };
}

function makeDeps(overrides: Partial<RouteDeps> = {}): RouteDeps {
  return {
    isSameOrigin: () => true,
    getOpenedFile: () => "/tmp/test.code-workspace",
    getAllRepos: () => [
      { id: "repo-1", rootPath: "/tmp/repo-1", commonDir: "/tmp/repo-1/.git" },
    ],
    getRegistry: () =>
      ({
        providers: [
          {
            id: "test-provider",
            name: "Test",
            description: "A test provider",
            capabilities: ["context"],
            riskLevel: "readonly",
            tools: [],
            getBlocks: () => [],
            getState: () => "available",
          },
        ],
      }) as unknown as IntegrationRegistry,
    buildContext: () => ({
      workspaceFilePath: "/tmp/test.code-workspace",
      workspaceName: "test-workspace",
      repos: [
        { id: "repo-1", rootPath: "/tmp/repo-1", displayName: "repo-1" },
      ],
    }),
    buildManifest: async () => ({
      workspaceName: "test-workspace",
      generatedAt: new Date().toISOString(),
      providers: [
        {
          id: "test-provider",
          name: "Test",
          description: "A test provider",
          state: "available",
          capabilities: ["context"],
          riskLevel: "readonly",
          tools: [],
          blocks: [],
        },
      ],
    }),
    jsonResponse: (body, init) => {
      const status = init?.status ?? 200;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }) as unknown as Response;
    },
    ...overrides,
  };
}

// Helper to parse a Response
async function parseResponse(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = await res.json() as Record<string, unknown>;
  return { status: res.status, body };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

void describe("handleIntegrationsGet", () => {
  void it("returns 403 for cross-origin requests", async () => {
    const deps = makeDeps({
      isSameOrigin: () => false,
    });
    const res = await handleIntegrationsGet(makeRequest("https://evil.com"), deps);
    const { status, body } = await parseResponse(res);
    strictEqual(status, 403);
    ok(typeof body.error === "string");
  });

  void it("returns 409 when no workspace is open", async () => {
    const deps = makeDeps({
      getOpenedFile: () => null,
    });
    const res = await handleIntegrationsGet(makeRequest(), deps);
    const { status, body } = await parseResponse(res);
    strictEqual(status, 409);
    strictEqual(body.code, "NO_WORKSPACE");
    ok(typeof body.error === "string");
  });

  void it("returns 409 when no repositories registered", async () => {
    const deps = makeDeps({
      getAllRepos: () => [],
    });
    const res = await handleIntegrationsGet(makeRequest(), deps);
    const { status, body } = await parseResponse(res);
    strictEqual(status, 409);
    strictEqual(body.code, "NO_REPOSITORIES");
    ok(typeof body.error === "string");
  });

  void it("returns 200 with manifest on success", async () => {
    const deps = makeDeps();
    const res = await handleIntegrationsGet(makeRequest(), deps);
    const { status, body } = await parseResponse(res);
    strictEqual(status, 200);
    const manifest = body as unknown as WorkspaceManifest;
    strictEqual(manifest.workspaceName, "test-workspace");
    ok(typeof manifest.generatedAt === "string");
    ok(Array.isArray(manifest.providers));
    strictEqual(manifest.providers.length, 1);
    strictEqual(manifest.providers[0].state, "available");
    strictEqual(manifest.providers[0].capabilities[0], "context");
  });

  void it("includes provider metadata in successful response", async () => {
    const deps = makeDeps();
    const res = await handleIntegrationsGet(makeRequest(), deps);
    const { status, body } = await parseResponse(res);
    strictEqual(status, 200);
    const manifest = body as unknown as WorkspaceManifest;
    const provider = manifest.providers[0];
    strictEqual(provider.id, "test-provider");
    strictEqual(provider.name, "Test");
    strictEqual(provider.riskLevel, "readonly");
  });

  void it("returns 500 with safe error when buildManifest throws", async () => {
    const deps = makeDeps({
      buildManifest: async () => {
        throw new Error("DB connection failed");
      },
    });
    const res = await handleIntegrationsGet(makeRequest(), deps);
    const { status, body } = await parseResponse(res);
    strictEqual(status, 500);
    strictEqual(body.code, "MANIFEST_ERROR");
    ok(typeof body.error === "string");
    // Must not contain raw exception or path details
    ok(
      !JSON.stringify(body).includes("DB connection failed"),
      "Must not leak exception message"
    );
    ok(
      !JSON.stringify(body).includes("/tmp/"),
      "Must not leak paths"
    );
  });

  void it("preserves same-origin enforcement order (origin check)", async () => {
    let isSameOriginCalled = false;
    const deps = makeDeps({
      isSameOrigin: () => {
        isSameOriginCalled = true;
        return false;
      },
    });
    await handleIntegrationsGet(makeRequest("https://evil.com"), deps);
    ok(isSameOriginCalled, "isSameOrigin should be consulted");
  });
});
