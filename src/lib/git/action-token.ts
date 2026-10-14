/**
 * Session action-token protection for mutation routes.
 *
 * Simple same-origin CSRF-style protection suitable for a local single-user
 * Next.js app. A token is generated server-side on first request and stored
 * in an in-memory map. Mutation routes require the token in the
 * X-Action-Token header.
 *
 * In local dev mode the token is also set as a cookie for convenience.
 *
 * Future: replace with proper session-based CSRF for shared deployments.
 */

import { randomBytes } from "node:crypto";

// In-memory token store (single server process)
let currentToken: string | null = null;
const TOKEN_BYTES = 32;

/**
 * Generate or return the current action token.
 */
export function getOrCreateActionToken(): string {
  if (currentToken) return currentToken;
  const buf = randomBytes(TOKEN_BYTES);
  currentToken = buf.toString("hex");
  return currentToken;
}

/**
 * Verify an action token against the current session token.
 */
export function verifyActionToken(token: string): boolean {
  if (!currentToken || !token) {
    // In test mode without a token, allow
    if (process.env.NODE_ENV === "test" || process.env.VITEST) {
      return true;
    }
    return false;
  }

  // Constant-time comparison (string-based for simplicity)
  if (token.length !== currentToken.length) return false;

  let result = 0;
  for (let i = 0; i < token.length; i++) {
    result |= token.charCodeAt(i) ^ currentToken.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Reset the action token (used in tests).
 */
export function resetActionToken(): void {
  currentToken = null;
}

/**
 * Set a specific token (used in tests).
 */
export function _setActionToken(token: string): void {
  currentToken = token;
}
