/**
 * POST /api/git/switch — execute a branch switch for a single repository.
 *
 * Body (JSON):
 *   repoId         — registered repository ID (required)
 *   target         — branch name or ref to switch to (required)
 *   createTracking — if true, create local tracking branch from remote (optional)
 *
 * Preconditions (enforced by preflightSwitch):
 * - Working tree must be clean
 * - Target branch must not be occupied by another worktree
 * - Target must exist locally or createTracking must be true
 *
 * NEVER: force checkout, auto-stash, reset, or discard changes.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRepo } from "@/lib/git/registry";
import { switchBranch } from "@/lib/git/operations";
import { verifyActionToken } from "@/lib/git/action-token";
import { isSameOriginRequest } from "@/lib/git/request-security";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  try {
    // Same-origin check
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: "Cross-origin requests not allowed" }, { status: 403 });
    }

    // Session action token
    const token = request.headers.get("x-action-token") ?? "";
    if (!verifyActionToken(token)) {
      return NextResponse.json({ error: "Missing or invalid action token" }, { status: 403 });
    }

    const body = await request.json();
    const { repoId, target, createTracking } = body as {
      repoId?: string;
      target?: string;
      createTracking?: boolean;
    };

    if (!repoId) {
      return NextResponse.json({ error: "Missing required field: repoId" }, { status: 400 });
    }

    if (!target) {
      return NextResponse.json({ error: "Missing required field: target" }, { status: 400 });
    }

    const repo = getRepo(repoId);
    if (!repo) {
      return NextResponse.json(
        { error: "Unknown repository ID — open a workspace first" },
        { status: 404 }
      );
    }

    const result = await switchBranch(repo, {
      repoId,
      target,
      createTracking: createTracking ?? false,
    });

    const status = result.success ? 200 : 422;
    return NextResponse.json({ result }, { status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Switch operation failed", detail: message },
      { status: 500 }
    );
  }
}
