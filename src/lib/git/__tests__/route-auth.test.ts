/**
 * Regression tests for the shared route guard used by snapshot
 * mutations, workspace open, task reads, and the git journal.
 *
 * Run: node --experimental-strip-types --loader ../scripts/register-ts.mjs \
 *       --test src/lib/git/__tests__/route-auth.test.ts
 */

import { describe, it, before, after } from "node:test";
import { strictEqual } from "node:assert";
import { routeAuthRejection, type AuthRequestLike } from "../route-auth";
import { _setActionToken, resetActionToken } from "../action-token";

const ORIGIN = "http://localhost:3000";

function request(headers: Record<string, string>): AuthRequestLike {
  const map = new Map(Object.entries(headers));
  return {
    url: `${ORIGIN}/api/snapshots/abcdef0123456789`,
    headers: { get: (name) => map.get(name.toLowerCase()) ?? null },
  };
}

void describe("routeAuthRejection", () => {
  before(() => {
    _setActionToken("route-auth-secret");
  });

  after(() => {
    resetActionToken();
  });

  void it("rejects a same-origin request without a token", () => {
    strictEqual(
      routeAuthRejection(request({ origin: ORIGIN })),
      "Missing or invalid action token"
    );
  });

  void it("rejects a request with a wrong token", () => {
    strictEqual(
      routeAuthRejection(
        request({ origin: ORIGIN, "x-action-token": "wrong" })
      ),
      "Missing or invalid action token"
    );
  });

  void it("rejects a cross-origin request even with a token", () => {
    strictEqual(
      routeAuthRejection(
        request({
          origin: "https://evil.example",
          "x-action-token": "route-auth-secret",
        })
      ),
      "Cross-origin requests not allowed"
    );
  });

  void it("allows a same-origin request with a valid token", () => {
    strictEqual(
      routeAuthRejection(
        request({ origin: ORIGIN, "x-action-token": "route-auth-secret" })
      ),
      null
    );
  });
});
