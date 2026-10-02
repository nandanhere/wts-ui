/**
 * GET/POST /api/git/session — plan and execute a clean workspace session.
 *
 * GET: read-only plan using cached remote refs (no network).
 * POST: execute — fetches chosen remote, creates session worktrees.
 *
 * ── GET ──────────────────────────────────────────────────────
 * Query params:
 *   repoIds — optional comma-separated subset of registered repo IDs
 *
 * Returns: SessionPlan
 *
 * ── POST ─────────────────────────────────────────────────────
 * Body (JSON):
 *   confirm — must be exactly "start"
 *   repoIds — optional array of registered repo IDs (validated + deduped)
 *
 * Requires:
 * - Same-origin request
 * - X-Action-Token header
 * - Malformed JSON => 400
 * - Unknown repo IDs => 400
 * - Concurrent session => 409
 *
 * Returns: SessionExecution
 */

import { NextRequest, NextResponse } from "next/server";
import { planSession, executeSession, hasActiveSession, getActiveSession } from "@/lib/git/workspace-session";
import { getAllRepos, getRepo } from "@/lib/git/registry";
import { verifyActionToken } from "@/lib/git/action-token";
import { isSameOriginRequest } from "@/lib/git/request-security";

export const dynamic = "force-dynamic";
const MAX_REPOS = 50;

/* ------------------------------------------------------------------ */
/*  GET — read-only plan                                               */
/* ------------------------------------------------------------------ */

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const repoIdsParam = request.nextUrl.searchParams.get("repoIds");
    let repoIds: string[] | undefined;

    if (repoIdsParam) {
      repoIds = [...new Set(repoIdsParam.split(",").map((s) => s.trim()).filter(Boolean))];
      if (repoIds.length > MAX_REPOS) {
        return NextResponse.json({ error: `Too many repository IDs (max ${MAX_REPOS})` }, { status: 400 });
      }
      const unknown = repoIds.filter((id) => !getRepo(id));
      if (unknown.length > 0) {
        return NextResponse.json(
          { error: "Unknown repository IDs", unknownRepoIds: unknown },
          { status: 400 }
        );
      }
    }

    const plan = planSession({ repoIds });

    // If there's an active session, attach it so the UI knows
    const active = getActiveSession();

    return NextResponse.json({ plan, active }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to build session plan", detail: message },
      { status: 500 }
    );
  }
}

/* ------------------------------------------------------------------ */
/*  POST — execute session                                             */
/* ------------------------------------------------------------------ */

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

    // Parse body
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError("Session body must be an object");
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { error: "Malformed JSON body" },
        { status: 400 }
      );
    }

    // Validate confirm field
    if (body.confirm !== "start") {
      return NextResponse.json(
        { error: 'Body confirm must be exactly "start"' },
        { status: 400 }
      );
    }

    // Validate and dedupe repoIds if provided
    let rawIds: string[] | undefined;
    if (body.repoIds !== undefined) {
      if (!Array.isArray(body.repoIds)) {
        return NextResponse.json(
          { error: "repoIds must be an array of strings" },
          { status: 400 }
        );
      }
      if (body.repoIds.length === 0 || body.repoIds.length > MAX_REPOS) {
        return NextResponse.json(
          { error: `repoIds must contain between 1 and ${MAX_REPOS} repository IDs` },
          { status: 400 }
        );
      }

      const seen = new Set<string>();
      const unknownIds: string[] = [];

      for (const id of body.repoIds) {
        if (typeof id !== "string" || !id.trim()) {
          return NextResponse.json(
            { error: "repoIds must contain only non-empty strings" },
            { status: 400 }
          );
        }
        const trimmed = id.trim();
        if (!seen.has(trimmed)) {
          seen.add(trimmed);
          if (!getRepo(trimmed)) {
            unknownIds.push(trimmed);
          }
        }
      }

      if (unknownIds.length > 0) {
        return NextResponse.json(
          { error: `Unknown repository IDs: ${unknownIds.join(", ")}` },
          { status: 400 }
        );
      }

      rawIds = Array.from(seen);
    }

    if (rawIds === undefined && getAllRepos().length === 0) {
      return NextResponse.json(
        { error: "No repositories are registered; open a workspace first" },
        { status: 400 }
      );
    }

    // Check for concurrent session
    if (hasActiveSession()) {
      const active = getActiveSession();
      return NextResponse.json(
        {
          error: "A workspace session is already active",
          active,
        },
        { status: 409 }
      );
    }

    // Execute
    const execution = await executeSession({ repoIds: rawIds });

    return NextResponse.json({ execution }, { status: 200 });
  } catch (err: unknown) {
    // Check for our own 409 error
    if (err instanceof Error && (err as Error & { statusCode?: number }).statusCode === 409) {
      return NextResponse.json(
        { error: err.message, active: getActiveSession() },
        { status: 409 }
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Session execution failed", detail: message },
      { status: 500 }
    );
  }
}
