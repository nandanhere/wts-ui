/**
 * Pure route-authorization decisions shared by API routes.
 *
 * Kept free of `next/server` imports so route guards can be tested in
 * plain Node. `request-security.ts` adapts these decisions to
 * NextResponse for use in route handlers.
 */

import { verifyActionToken } from "@/lib/git/action-token";

/** Minimal request shape needed for authorization decisions. */
export interface AuthRequestLike {
  url: string;
  headers: { get(name: string): string | null };
}

/** True when Origin or Referer matches the request origin. */
export function isSameOrigin(headers: AuthRequestLike["headers"], url: string): boolean {
  const requestUrl = new URL(url);
  const origin = headers.get("origin");
  const referer = headers.get("referer");

  if (origin && origin !== "null") {
    try {
      return new URL(origin).origin === requestUrl.origin;
    } catch {
      return false;
    }
  }

  if (referer) {
    try {
      return new URL(referer).origin === requestUrl.origin;
    } catch {
      return false;
    }
  }

  return process.env.NODE_ENV === "test";
}

/**
 * Authorization decision for mutation routes and sensitive reads.
 *
 * Returns an error message when the request must be rejected with
 * 403, or null when the handler may proceed.
 */
export function routeAuthRejection(request: AuthRequestLike): string | null {
  if (!isSameOrigin(request.headers, request.url)) {
    return "Cross-origin requests not allowed";
  }
  const token = request.headers.get("x-action-token") ?? "";
  if (!verifyActionToken(token)) {
    return "Missing or invalid action token";
  }
  return null;
}
