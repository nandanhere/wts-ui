import { NextRequest, NextResponse } from "next/server";
import { getOrCreateActionToken } from "@/lib/git/action-token";
import { isSameOriginRequest } from "@/lib/git/request-security";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "Same-origin request required" },
      { status: 403 }
    );
  }

  return NextResponse.json(
    { token: getOrCreateActionToken() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
