/**
 * POST /api/git/worktree — create or remove a worktree.
 *
 * Action determined by body field:
 *   action: "create" | "remove"
 *
 * Create body:
 *   repoId    — registered repository ID (required)
 *   branch    — branch to check out in the worktree (required)
 *   targetPath — optional explicit path
 *   baseRef   — optional base ref for new branches (default origin/<branch>)
 *
 * Remove body:
 *   repoId    — registered repository ID (required)
 *   path      — worktree path to remove (required)
 *
 * NEVER: force remove, prune, or modify primary worktree.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRepo } from "@/lib/git/registry";
import { createWorktree, removeWorktree } from "@/lib/git/operations";
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
    const { action, repoId, branch, targetPath, baseRef, path } = body as {
      action?: string;
      repoId?: string;
      branch?: string;
      targetPath?: string;
      baseRef?: string;
      path?: string;
    };

    if (!action || !repoId) {
      return NextResponse.json(
        { error: "Missing required fields: action, repoId" },
        { status: 400 }
      );
    }

    if (action !== "create" && action !== "remove") {
      return NextResponse.json(
        { error: 'Invalid action. Must be "create" or "remove"' },
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

    let result;

    if (action === "create") {
      if (!branch) {
        return NextResponse.json({ error: "Missing required field: branch" }, { status: 400 });
      }
      result = await createWorktree(repo, {
        repoId,
        branch,
        targetPath,
        baseRef,
      });
    } else {
      if (!path) {
        return NextResponse.json({ error: "Missing required field: path" }, { status: 400 });
      }
      result = await removeWorktree(repo, {
        repoId,
        path,
      });
    }

    const status = result.success ? 200 : 422;
    return NextResponse.json({ result }, { status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Worktree operation failed", detail: message },
      { status: 500 }
    );
  }
}
