/**
 * GET /api/git/status — live status for selected repositories.
 *
 * Query params:
 *   repoIds — comma-separated repository IDs from a previously opened workspace
 *   ttlMs   — optional cache TTL override (default 5000)
 *
 * Returns RepoStatus[] for the requested repos.
 * Repos are resolved from the in-memory repo registry (populated by workspace/open).
 * If a repo ID is unknown it's returned with an error entry.
 *
 * Read-only. No auth required in local single-user mode.
 */

import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceStatus } from "@/lib/git/status";
import { getRepo } from "@/lib/git/registry";
import type { Repository } from "@/lib/workspace/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const repoIdsParam = request.nextUrl.searchParams.get("repoIds");
    const ttlMsParam = request.nextUrl.searchParams.get("ttlMs");

    if (!repoIdsParam) {
      return NextResponse.json(
        { error: "Missing required query parameter: repoIds" },
        { status: 400 }
      );
    }

    const repoIds = repoIdsParam.split(",").map((s) => s.trim()).filter(Boolean);
    const ttlMs = ttlMsParam ? parseInt(ttlMsParam, 10) : undefined;

    if (repoIds.length === 0) {
      return NextResponse.json({ repos: [] });
    }

    // Limit batch size
    if (repoIds.length > 50) {
      return NextResponse.json(
        { error: "Too many repo IDs (max 50)" },
        { status: 400 }
      );
    }

    // Resolve repos from shared registry
    const repos: Repository[] = [];
    const errors: { repoId: string; error: string }[] = [];

    for (const id of repoIds) {
      const repo = getRepo(id);
      if (repo) {
        repos.push(repo);
      } else {
        errors.push({ repoId: id, error: "Unknown repository ID — open a workspace first" });
      }
    }

    // Get status
    const statuses = getWorkspaceStatus(repos, { ttlMs });

    // Attach error entries for unknown repos
    for (const err of errors) {
      statuses.push({
        repoId: err.repoId,
        rootPath: "",
        currentBranch: "(unknown)",
        headRef: "",
        headOid: "",
        upstream: null,
        ahead: 0,
        behind: 0,
        v2Status: null,
        localBranches: [],
        remotes: [],
        remoteRefs: [],
        worktrees: [],
        errors: [err.error],
        cachedAt: Date.now(),
      });
    }

    return NextResponse.json({ repos: statuses });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to read repository status", detail: message },
      { status: 500 }
    );
  }
}
