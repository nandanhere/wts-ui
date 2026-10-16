import { NextRequest, NextResponse } from "next/server";
import { getOrCreateActionToken } from "@/lib/git/action-token";
import { isSameOriginRequest } from "@/lib/git/request-security";

export const dynamic = "force-dynamic";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Tokens are issued only to loopback hosts. The app is local and
 * single-user; a network-reachable deployment must not hand the
 * process-global token to any client that can spoof an Origin header.
 */
function isLoopbackRequest(request: NextRequest): boolean {
  const host = request.headers.get("host") ?? "";
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  return LOOPBACK_HOSTS.has(hostname);
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "Same-origin request required" },
      { status: 403 }
    );
  }

  if (!isLoopbackRequest(request)) {
    return NextResponse.json(
      { error: "Action tokens are issued only on loopback" },
      { status: 403 }
    );
  }

  return NextResponse.json(
    { token: getOrCreateActionToken() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
