/**
 * Session action-token protection for mutation routes.
 *
 * Simple same-origin CSRF-style protection suitable for a local single-user
 * Next.js app. A token is generated server-side on first request and stored
 * in memory. Mutation routes require the token in the X-Action-Token header.
 *
 * The token expires after ACTION_TOKEN_TTL_MS and is then rotated, so a
 * leaked token does not grant access forever. The token route additionally
 * issues tokens only to loopback hosts.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

// In-memory token store (single server process)
let currentToken: string | null = null;
let currentTokenCreatedAt = 0;
const TOKEN_BYTES = 32;

/** How long an issued action token stays valid (12 hours). */
export const ACTION_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function tokenExpired(): boolean {
  return (
    currentToken !== null &&
    Date.now() - currentTokenCreatedAt >= ACTION_TOKEN_TTL_MS
  );
}

/**
 * Generate or return the current action token.
 * Rotates the token once the previous one has expired.
 */
export function getOrCreateActionToken(): string {
  if (currentToken && !tokenExpired()) return currentToken;
  const buf = randomBytes(TOKEN_BYTES);
  currentToken = buf.toString("hex");
  currentTokenCreatedAt = Date.now();
  return currentToken;
}

/**
 * Verify an action token against the current session token.
 * Expired tokens are rejected even when no rotation has happened yet.
 */
export function verifyActionToken(token: string): boolean {
  if (!currentToken || !token) {
    // In test mode without a token, allow
    if (process.env.NODE_ENV === "test" || process.env.VITEST) {
      return true;
    }
    return false;
  }

  if (tokenExpired()) return false;

  const expected = Buffer.from(currentToken, "utf-8");
  const provided = Buffer.from(token, "utf-8");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Reset the action token (used in tests).
 */
export function resetActionToken(): void {
  currentToken = null;
  currentTokenCreatedAt = 0;
}

/**
 * Set a specific token (used in tests).
 */
export function _setActionToken(token: string): void {
  currentToken = token;
  currentTokenCreatedAt = Date.now();
}
