/**
 * POST /api/git/fetch — execute a fetch for a single repository.
 *
 * Body (JSON):
 *   repoId — registered repository ID (required)
 *   remote — remote name (optional, defaults to "origin")
 *   prune  — whether to prune stale remote-tracking refs (optional, default false)
 *
 * Requires:
 * - repoId to be registered via workspace/open
 * - origin/same-origin Referer header (in local dev)
 * - Session action token in X-Action-Token header
 *
 * NEVER: fetches all remotes, fetches all repos, or modifies config.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRepo } from "@/lib/git/registry";
import { fetchRepo } from "@/lib/git/operations";
import { verifyActionToken } from "@/lib/git/action-token";
import { isSameOriginRequest } from "@/lib/git/request-security";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  try {
    // Same-origin check (best-effort in local dev)
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: "Cross-origin requests not allowed" }, { status: 403 });
    }

    // Session action token
    const token = request.headers.get("x-action-token") ?? "";
    if (!verifyActionToken(token)) {
      return NextResponse.json({ error: "Missing or invalid action token" }, { status: 403 });
    }

    const body = await request.json();
    const { repoId, remote, prune } = body as {
      repoId?: string;
      remote?: string;
      prune?: boolean;
    };

    if (!repoId) {
      return NextResponse.json({ error: "Missing required field: repoId" }, { status: 400 });
    }

    const repo = getRepo(repoId);
    if (!repo) {
      return NextResponse.json(
        { error: "Unknown repository ID — open a workspace first" },
        { status: 404 }
      );
    }

    const result = await fetchRepo(repo, {
      repoId,
      remote: remote ?? "origin",
      prune: prune ?? false,
    });

    const status = result.success ? 200 : 422;
    return NextResponse.json({ result }, { status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Fetch operation failed", detail: message },
      { status: 500 }
    );
  }
}
