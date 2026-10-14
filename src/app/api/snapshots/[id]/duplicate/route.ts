/**
 * POST /api/snapshots/[id]/duplicate
 *
 * Duplicate a snapshot with a new label.
 * Body (JSON):
 *   label — required, new label for the duplicate
 *
 * Returns the new SnapshotEntry.
 * 404 if source snapshot not found.
 * 400 if label is missing.
 */

import { NextRequest, NextResponse } from "next/server";
import { duplicateSnapshot } from "@/lib/snapshot/store";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await params;

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    const newLabel = typeof body.label === "string" && body.label.trim()
      ? body.label.trim()
      : null;

    if (!newLabel) {
      return NextResponse.json(
        { error: "Missing required field: label" },
        { status: 400 }
      );
    }

    const entry = duplicateSnapshot(id, newLabel);
    if (!entry) {
      return NextResponse.json(
        { error: "Source snapshot not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ snapshot: entry }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to duplicate snapshot", detail: message },
      { status: 500 }
    );
  }
}
