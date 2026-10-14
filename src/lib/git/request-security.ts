import type { NextRequest } from "next/server";

/** Require an Origin or Referer matching the request origin for mutations. */
export function isSameOriginRequest(request: NextRequest): boolean {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

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
