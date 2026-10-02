/**
 * GET /api/snapshots/[id]/restore
 *
 * Generate a restore plan from drift analysis.
 *
 * This is a PLAN ONLY — never executes restore or destructive operations.
 * Returns a RestorePlan with per-repo actions, auto-executable flags, and
 * prerequisites.
 *
 * 404 if snapshot not found.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSnapshot } from "@/lib/snapshot/store";
import { analyzeDrift, generateRestorePlan } from "@/lib/snapshot/drift";
import { activateSnapshot } from "@/lib/snapshot/activate";
import { verifyActionToken } from "@/lib/git/action-token";
import { isSameOriginRequest } from "@/lib/git/request-security";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await params;
    const snapshot = getSnapshot(id);

    if (!snapshot) {
      return NextResponse.json(
        { error: "Snapshot not found" },
        { status: 404 }
      );
    }

    const drift = analyzeDrift(snapshot);
    const plan = generateRestorePlan(drift);

    return NextResponse.json({ plan });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to generate restore plan", detail: message },
      { status: 500 }
    );
  }
}

/**
 * Activate safe entries from a saved combination.
 *
 * Body: { confirm: "activate", repoIds?: string[] }
 *
 * The executor re-analyzes live state and leaves all unsafe entries blocked.
 * It never stashes, resets, discards, force-checks-out, rewrites a branch, or
 * fetches from the network.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json(
        { error: "Cross-origin requests not allowed" },
        { status: 403 }
      );
    }

    const token = request.headers.get("x-action-token") ?? "";
    if (!verifyActionToken(token)) {
      return NextResponse.json(
        { error: "Missing or invalid action token" },
        { status: 403 }
      );
    }

    let body: { confirm?: unknown; repoIds?: unknown };
    try {
      const parsed: unknown = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError("Activation body must be an object");
      }
      body = parsed as { confirm?: unknown; repoIds?: unknown };
    } catch {
      return NextResponse.json(
        { error: "Request body must be valid JSON object" },
        { status: 400 }
      );
    }
    if (body.confirm !== "activate") {
      return NextResponse.json(
        { error: "Explicit activation confirmation is required" },
        { status: 400 }
      );
    }

    let repoIds: string[] | undefined;
    if (body.repoIds !== undefined) {
      if (
        !Array.isArray(body.repoIds) ||
        body.repoIds.length === 0 ||
        body.repoIds.length > 500 ||
        body.repoIds.some((repoId) => typeof repoId !== "string" || !repoId)
      ) {
        return NextResponse.json(
          { error: "repoIds must be a non-empty array of at most 500 repository IDs" },
          { status: 400 }
        );
      }
      repoIds = [...new Set(body.repoIds as string[])];
    }

    const { id } = await params;
    const snapshot = getSnapshot(id);
    if (!snapshot) {
      return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });
    }

    if (repoIds) {
      const snapshotRepoIds = new Set(snapshot.repos.map((repo) => repo.repoId));
      const unknown = repoIds.filter((repoId) => !snapshotRepoIds.has(repoId));
      if (unknown.length > 0) {
        return NextResponse.json(
          { error: "Requested repositories are not present in this snapshot", unknownRepoIds: unknown },
          { status: 400 }
        );
      }
    }

    const activation = await activateSnapshot(id, snapshot, repoIds);
    return NextResponse.json({ activation });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Combination activation failed", detail: message },
      { status: 500 }
    );
  }
}
