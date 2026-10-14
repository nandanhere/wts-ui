/**
 * GET /api/graphify — Graphify capability status for workspace repos.
 *
 * Query params:
 *   workspace  (required) — Absolute path to a .code-workspace file
 *   repoId     (optional) — If set, return status only for this repo
 *
 * Returns a GraphifyStatusResponse with per-repo artifact metadata.
 * Absence of graphify is non-fatal (available: false per repo).
 * Never loads graph.json contents.
 *
 * Read-only. Authorized only for registered repo roots from the scan.
 */

import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { loadWorkspaceFile } from "@/lib/workspace/parser";
import { scanWorkspace } from "@/lib/workspace/discovery";
import { enrichReposWithGraphify } from "@/lib/graphify/server";

export const dynamic = "force-dynamic";

function resolveWorkspacePath(rawPath: string): string | null {
  let resolved: string;

  if (rawPath.startsWith("~/") || rawPath === "~") {
    resolved = resolve(homedir(), rawPath.slice(1));
  } else if (isAbsolute(rawPath)) {
    resolved = resolve(rawPath);
  } else {
    return null;
  }

  if (!/\.code-workspace$/i.test(resolved)) return null;
  if (!existsSync(resolved)) return null;
  return resolved;
}

export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const wsPath = request.nextUrl.searchParams.get("workspace");
    if (!wsPath) {
      return NextResponse.json(
        { error: "Missing required query parameter: workspace" },
        { status: 400 }
      );
    }

    const resolvedWsPath = resolveWorkspacePath(wsPath);
    if (!resolvedWsPath) {
      return NextResponse.json(
        {
          error:
            "Invalid workspace path: must be an absolute path to a .code-workspace file",
        },
        { status: 400 }
      );
    }

    // Parse and scan the workspace
    const ws = loadWorkspaceFile(resolvedWsPath);
    const scanResult = scanWorkspace(ws);

    // Enrich with graphify metadata
    const graphifyStatus = enrichReposWithGraphify(scanResult);

    // Optional single-repo filter
    const filterRepoId = request.nextUrl.searchParams.get("repoId");
    if (filterRepoId) {
      const filtered = graphifyStatus.repos[filterRepoId];
      if (!filtered) {
        return NextResponse.json(
          {
            repos: {},
            errors: [`Repository not found: ${filterRepoId}`],
          },
          { status: 404 }
        );
      }
      return NextResponse.json({
        repos: { [filterRepoId]: filtered },
        errors: graphifyStatus.errors,
      });
    }

    return NextResponse.json(graphifyStatus);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to query graphify status", detail: message },
      { status: 500 }
    );
  }
}
