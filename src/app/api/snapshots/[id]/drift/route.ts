/**
 * GET /api/snapshots/[id]/drift
 *
 * Analyze drift between a snapshot and current live repository state.
 * Read-only — never executes restore or destructive operations.
 *
 * Returns a DriftResult with per-repo classifications and summary counts.
 * 404 if snapshot not found.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSnapshot } from "@/lib/snapshot/store";
import { analyzeDrift } from "@/lib/snapshot/drift";

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
    return NextResponse.json({ drift });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to analyze drift", detail: message },
      { status: 500 }
    );
  }
}
