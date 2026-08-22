/**
 * GET /api/git/preflight — preflight check for a mutation operation.
 *
 * Query params:
 *   action   — "fetch" | "switch" | "worktree-create" | "worktree-remove"
 *   repoId   — registered repository ID
 *   target   — branch name, ref, remote name, or worktree path
 *   createTracking — "true" for switch actions that need remote tracking
 *
 * Returns a PreflightCheck result.
 * Read-only — does not perform the actual mutation.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRepo } from "@/lib/git/registry";
import {
  preflightFetch,
  preflightSwitch,
  preflightWorktreeCreate,
  preflightWorktreeRemove,
} from "@/lib/git/preflight";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const action = request.nextUrl.searchParams.get("action");
    const repoId = request.nextUrl.searchParams.get("repoId");
    const target = request.nextUrl.searchParams.get("target") ?? "";
    const createTracking = request.nextUrl.searchParams.get("createTracking") === "true";

    if (!action || !repoId) {
      return NextResponse.json(
        { error: "Missing required query parameters: action, repoId" },
        { status: 400 }
      );
    }

    const validActions = ["fetch", "switch", "worktree-create", "worktree-remove"];
    if (!validActions.includes(action)) {
      return NextResponse.json(
        { error: `Invalid action: "${action}". Valid actions: ${validActions.join(", ")}` },
        { status: 400 }
      );
    }

    if (!target && action !== "fetch") {
      return NextResponse.json(
        { error: "Missing required query parameter: target" },
        { status: 400 }
      );
    }

    const repo = getRepo(repoId);
    if (!repo) {
      return NextResponse.json(
        { error: "Unknown repository ID — open a workspace first" },
        { status: 404 }
      );
    }

    let check;

    switch (action) {
      case "fetch": {
        check = preflightFetch(repo, target || "origin");
        break;
      }
      case "switch": {
        check = preflightSwitch(repo, target, createTracking);
        break;
      }
      case "worktree-create": {
        check = preflightWorktreeCreate(repo, target);
        break;
      }
      case "worktree-remove": {
        check = preflightWorktreeRemove(repo, target);
        break;
      }
      default: {
        return NextResponse.json({ error: `Unsupported action: ${action}` }, { status: 400 });
      }
    }

    return NextResponse.json({ preflight: check });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Preflight check failed", detail: message },
      { status: 500 }
    );
  }
}
