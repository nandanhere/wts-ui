/**
 * POST /api/config-inventory — scan registered repos for config files.
 *
 * Read-only: returns metadata only, never content/values.
 * Bounded: respects configurable limits for depth, files, bytes.
 * Authorized: only accepts registered repository IDs.
 *
 * No shell commands, no watchers, no automatic scanning.
 * Scans happen only when this endpoint is explicitly called.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAllRepos, getRepo } from "@/lib/git/registry";
import { scanRepositories } from "@/lib/config-inventory/scanner";
import type { ConfigInventoryRequest, ScannerOptions } from "@/lib/config-inventory/types";
import { isSameOriginRequest } from "@/lib/git/request-security";

export const dynamic = "force-dynamic";

/**
 * POST /api/config-inventory
 *
 * Body (JSON):
 *   repoIds              — required, array of registered repo IDs
 *   limits               — optional scan limit overrides
 *   excludeDirPatterns   — optional additional directory exclusion patterns
 *
 * Returns: { results, unknownRepoIds, anyTruncated }
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json(
        { error: "Cross-origin requests not allowed" },
        { status: 403 }
      );
    }
    // Validate that we have a registered workspace
    const allRepos = getAllRepos();
    if (allRepos.length === 0) {
      return NextResponse.json(
        { error: "No registered repositories. Open a workspace first." },
        { status: 400 }
      );
    }

    let body: ConfigInventoryRequest;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    if (!Array.isArray(body.repoIds) || body.repoIds.length === 0) {
      return NextResponse.json(
        { error: "Missing required field: repoIds (non-empty array)" },
        { status: 400 }
      );
    }

    // Validate all requested repo IDs are registered
    const unknown: string[] = [];
    for (const id of body.repoIds) {
      if (!getRepo(id)) unknown.push(id);
    }

    if (unknown.length > 0) {
      return NextResponse.json(
        {
          error: "Unknown repository IDs",
          unknownRepoIds: unknown,
          knownRepoIds: body.repoIds.filter((id) => getRepo(id) !== undefined),
        },
        { status: 400 }
      );
    }

    // Resolver: maps repo ID → root path from the git registry
    const resolve = (id: string): { rootPath: string } | null => {
      const repo = getRepo(id);
      if (!repo) return null;
      return { rootPath: repo.rootPath };
    };

    const options: ScannerOptions = {};
    if (body.limits) options.limits = body.limits;
    if (body.excludeDirPatterns) options.excludeDirPatterns = body.excludeDirPatterns;

    const { results, unknownRepoIds } = scanRepositories(
      body.repoIds,
      resolve,
      options,
    );

    const anyTruncated = results.some((r) => r.truncated);

    return NextResponse.json({
      results,
      unknownRepoIds,
      anyTruncated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Internal error", detail: message },
      { status: 500 }
    );
  }
}
