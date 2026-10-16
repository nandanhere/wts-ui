/**
 * Tests for session action token.
 * Run: node --experimental-strip-types --test src/lib/git/__tests__/action-token.test.ts
 */

import { describe, it, before, after } from "node:test";
import { ok, strictEqual } from "node:assert";
import {
  getOrCreateActionToken,
  verifyActionToken,
  resetActionToken,
  _setActionToken,
  ACTION_TOKEN_TTL_MS,
} from "../action-token";

void describe("ActionToken", () => {
  before(() => {
    resetActionToken();
  });

  after(() => {
    resetActionToken();
    delete process.env.ACTION_TOKEN_INSECURE;
  });

  void it("generates a token on first call", () => {
    const token = getOrCreateActionToken();
    ok(token.length > 0, "should generate a token");
  });

  void it("returns the same token on subsequent calls", () => {
    const token1 = getOrCreateActionToken();
    const token2 = getOrCreateActionToken();
    strictEqual(token1, token2, "should return same token");
  });

  void it("verifies a valid token", () => {
    const token = getOrCreateActionToken();
    ok(verifyActionToken(token), "should verify valid token");
  });

  void it("rejects an invalid token", () => {
    ok(verifyActionToken("invalid-token") === false, "should reject invalid token");
  });

  void it("rejects empty token", () => {
    const result = verifyActionToken("");
    // If ACTION_TOKEN_INSECURE is not set, this should be false
    ok(result === false);
  });

  void it("rejects and rotates the token after the TTL", () => {
    resetActionToken();
    const first = getOrCreateActionToken();
    const realNow = Date.now;
    Date.now = () => realNow() + ACTION_TOKEN_TTL_MS + 1;
    try {
      ok(verifyActionToken(first) === false, "expired token must not verify");
      const second = getOrCreateActionToken();
      ok(second !== first, "expired token must rotate");
      ok(verifyActionToken(second), "rotated token must verify");
    } finally {
      Date.now = realNow;
      resetActionToken();
    }
  });

  void it("_setActionToken allows setting a specific token", () => {
    _setActionToken("test-token-123");
    ok(verifyActionToken("test-token-123"), "should verify set token");
    ok(verifyActionToken("wrong") === false, "should reject wrong token");
  });
});
