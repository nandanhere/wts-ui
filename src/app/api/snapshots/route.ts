/**
 * GET /api/snapshots — list all snapshots (metadata only).
 * POST /api/snapshots — create a new snapshot from registered repos.
 *
 * Authorization: requires an opened workspace with registered repos.
 * No remote URLs, secrets, diffs or contents stored.
 */

import { NextRequest, NextResponse } from "next/server";
import { listSnapshots, createSnapshot } from "@/lib/snapshot/store";
import { captureSnapshot } from "@/lib/snapshot/capture";
import { getAllRepos, getOpenedWorkspaceFilePath } from "@/lib/git/registry";

export const dynamic = "force-dynamic";

/**
 * GET /api/snapshots
 *
 * Returns all stored snapshots (metadata only, no repo data).
 */
export async function GET(): Promise<Response> {
  try {
    const snapshots = listSnapshots();
    return NextResponse.json({ snapshots });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to list snapshots", detail: message },
      { status: 500 }
    );
  }
}

/**
 * POST /api/snapshots
 *
 * Create a new snapshot from all currently registered repositories.
 * Body (JSON):
 *   label        — required, human-readable name
 *   description  — optional description
 *   source       — optional, defaults to "manual"
 *
 * Authorization: requires at least one registered repo (workspace/open first).
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const repos = getAllRepos();
    if (repos.length === 0) {
      return NextResponse.json(
        { error: "No registered repositories. Open a workspace first." },
        { status: 400 }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    const label = typeof body.label === "string" && body.label.trim()
      ? body.label.trim()
      : null;
    if (!label) {
      return NextResponse.json(
        { error: "Missing required field: label" },
        { status: 400 }
      );
    }

    const description = typeof body.description === "string" ? body.description : undefined;
    const source = body.source === "auto" || body.source === "restore-point"
      ? body.source
      : "manual";

    const workspaceFilePath = getOpenedWorkspaceFilePath();
    if (!workspaceFilePath) {
      return NextResponse.json(
        { error: "No opened workspace identity. Re-open the workspace before capturing." },
        { status: 400 }
      );
    }

    const schema = captureSnapshot(
      repos,
      label,
      workspaceFilePath,
      description,
      source
    );

    const entry = createSnapshot(schema);

    return NextResponse.json({ snapshot: entry }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to create snapshot", detail: message },
      { status: 500 }
    );
  }
}
