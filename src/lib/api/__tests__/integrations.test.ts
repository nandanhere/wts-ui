/**
 * Tests for the client-side integrations API layer.
 *
 * Uses global fetch mocking to test URL construction, error handling,
 * AbortSignal passthrough, and malformed responses.
 *
 * Runs with { concurrency: 1 } because tests share global fetch mock state.
 *
 * Run: node --experimental-strip-types --loader ../../../scripts/register-ts.mjs \
 *       --test src/lib/api/__tests__/integrations.test.ts
 */

import { describe, it, before, after } from "node:test";
import { ok, strictEqual } from "node:assert";
import { fetchIntegrationsManifest } from "../integrations";

/* ------------------------------------------------------------------ */
/*  Mock helpers                                                       */
/* ------------------------------------------------------------------ */

let mockResponse: Response | null = null;
let mockError: Error | null = null;
let capturedUrl: string | undefined;
let capturedInit: RequestInit | undefined;
let originalFetch: typeof globalThis.fetch | null = null;

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = typeof url === "string" ? url : url.toString();
    capturedInit = init;
    // Respect pre-aborted signals
    if (init?.signal?.aborted) {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    }
    if (mockError) return Promise.reject(mockError);
    if (mockResponse) return Promise.resolve(mockResponse);
    return Promise.reject(new Error("No mock response set"));
  }) as typeof globalThis.fetch;
});

after(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
});

function setMock(status: number, body: unknown): void {
  mockError = null;
  mockResponse = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setMockNetworkError(msg: string): void {
  mockResponse = null;
  mockError = new Error(msg);
}

function setMockRaw(raw: string, status: number): void {
  mockError = null;
  mockResponse = new Response(raw, {
    status,
    headers: { "content-type": "application/json" },
  });
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

void describe("fetchIntegrationsManifest", { concurrency: 1 }, () => {
  void it("returns parsed manifest on 200", async () => {
    setMock(200, {
      workspaceName: "test",
      generatedAt: new Date().toISOString(),
      providers: [],
    });
    const result = await fetchIntegrationsManifest();
    strictEqual(result.workspaceName, "test");
    ok(Array.isArray(result.providers));
  });

  void it("throws on non-200 with error from body", async () => {
    setMock(400, { error: "Bad request" });
    try {
      await fetchIntegrationsManifest();
      ok(false, "Expected error");
    } catch (err) {
      ok(err instanceof Error);
      ok(err.message.includes("Bad request"));
    }
  });

  void it("throws fallback message when body has no error field", async () => {
    setMock(500, {});
    try {
      await fetchIntegrationsManifest();
      ok(false, "Expected error");
    } catch (err) {
      ok(err instanceof Error);
      ok(err.message.includes("API error 500"));
    }
  });

  void it("throws on network failure", async () => {
    setMockNetworkError("Network failure");
    try {
      await fetchIntegrationsManifest();
      ok(false, "Expected error");
    } catch (err) {
      ok(err instanceof Error);
      ok(err.message.includes("Network failure"));
    }
  });

  void it("throws when body JSON is malformed", async () => {
    setMockRaw("not json", 200);
    try {
      await fetchIntegrationsManifest();
      ok(false, "Expected error");
    } catch {
      ok(true, "Threw on malformed JSON");
    }
  });

  void it("sends request to correct URL with no query params", async () => {
    setMock(200, {
      workspaceName: "url-test",
      generatedAt: new Date().toISOString(),
      providers: [],
    });
    capturedUrl = undefined;
    capturedInit = undefined;
    await fetchIntegrationsManifest();
    ok(capturedUrl, "fetch should have been called");
    const url = new URL(capturedUrl!);
    strictEqual(url.pathname, "/api/integrations");
    strictEqual(url.search, "", "No query/search params");
  });

  void it("accepts and passes AbortSignal with exact identity", async () => {
    setMock(200, {
      workspaceName: "signal-test",
      generatedAt: new Date().toISOString(),
      providers: [],
    });
    capturedInit = undefined;
    const controller = new AbortController();
    const result = await fetchIntegrationsManifest(controller.signal);
    strictEqual(result.workspaceName, "signal-test");
    ok(capturedInit, "fetch init should exist");
    // Must pass the exact same AbortSignal (identity, not just properties)
    strictEqual(
      capturedInit!.signal,
      controller.signal,
      "AbortSignal identity must be preserved"
    );
  });

  void it("rejects with AbortError when signal is already aborted", async () => {
    setMock(200, {
      workspaceName: "pre-aborted",
      generatedAt: new Date().toISOString(),
      providers: [],
    });
    const controller = new AbortController();
    controller.abort(); // Pre-abort

    try {
      await fetchIntegrationsManifest(controller.signal);
      ok(false, "Expected AbortError to be thrown");
    } catch (err) {
      // In Node.js, an aborted signal causes fetch to reject with a TypeError
      // named "AbortError". In browser it's a DOMException named "AbortError".
      const errObj = err as Error;
      ok(
        errObj.name === "AbortError" || errObj.name === "TypeError",
        `Expected AbortError/TypeError, got "${errObj.name}"`
      );
    }
  });
});
