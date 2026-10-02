/**
 * GET /api/graphify/lazy — Safe read-only operations on existing graphs.
 *
 * Query params:
 *   repoId    (required) — Registered repository ID
 *   op        (required) — Operation: "meta", "open-html", "wiki"
 *
 * Authorization: only paths that are registered workspace repos are accepted.
 * The caller must provide the repoRoot explicitly; the server module validates
 * it against the workspace scan's own authorized set (handled by the caller).
 *
 * This endpoint is intentionally limited to small, safe operations.
 * It NEVER generates graphs, starts watchers, or runs expensive commands.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getGraphMeta,
  getGraphHtmlUrl,
  getWikiSnippet,
} from "@/lib/graphify/operations";
import { getRepo } from "@/lib/git/registry";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const repoId = request.nextUrl.searchParams.get("repoId");
    const op = request.nextUrl.searchParams.get("op");

    if (!repoId || !op) {
      return NextResponse.json(
        {
          error: "Missing required query parameters: repoId, op",
        },
        { status: 400 }
      );
    }

    const validOps = ["meta", "open-html", "wiki"];
    if (!validOps.includes(op)) {
      return NextResponse.json(
        {
          error: `Invalid operation: "${op}". Valid: ${validOps.join(", ")}`,
        },
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
    const resolved = repo.rootPath;

    switch (op) {
      case "meta": {
        const meta = getGraphMeta(resolved);
        if (!meta) {
          return NextResponse.json(
            { error: "No graph.json found, oversized, or unparseable", repoId },
            { status: 404 }
          );
        }
        return NextResponse.json({ repoId, meta });
      }

      case "open-html": {
        const url = getGraphHtmlUrl(resolved);
        if (!url) {
          return NextResponse.json(
            { error: "No graph.html found", repoId },
            { status: 404 }
          );
        }
        return NextResponse.json({ repoId, url });
      }

      case "wiki": {
        const snippet = getWikiSnippet(resolved);
        if (snippet === null) {
          return NextResponse.json(
            { error: "No wiki/index.md found", repoId },
            { status: 404 }
          );
        }
        return NextResponse.json({ repoId, snippet });
      }

      default:
        return NextResponse.json({ error: "Unknown operation" }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Lazy operation failed", detail: message },
      { status: 500 }
    );
  }
}
