import type { NextRequest } from "next/server";
import { isSameOrigin, routeAuthRejection } from "@/lib/git/route-auth";

/** Require an Origin or Referer matching the request origin for mutations. */
export function isSameOriginRequest(request: NextRequest): boolean {
  return isSameOrigin(request.headers, request.url);
}

/**
 * Shared route guard: same-origin plus a valid action token.
 *
 * Returns a 403 response when the request must be rejected, or null
 * when the handler may proceed. Use for every mutation route and for
 * read routes that expose process output, paths, or audit history.
 *
 * Uses the standard Response API (not NextResponse) so this module
 * stays importable from plain-Node tests.
 */
export function rejectIfNotAuthorized(request: NextRequest): Response | null {
  const error = routeAuthRejection({
    url: request.url,
    headers: request.headers,
  });
  if (!error) return null;
  return Response.json({ error }, { status: 403 });
}
