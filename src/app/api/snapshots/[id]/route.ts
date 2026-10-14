/**
 * GET    /api/snapshots/[id] — get full snapshot schema
 * DELETE /api/snapshots/[id] — delete a snapshot
 * PATCH  /api/snapshots/[id] — update snapshot metadata (label, description)
 *
 * Snapshot IDs are derived from content hashes — no enumeration risk.
 * Authorization: local single-user app (no auth required for read/delete of own snapshots).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSnapshot, deleteSnapshot, updateSnapshotMeta } from "@/lib/snapshot/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/snapshots/[id]
 *
 * Returns the full snapshot schema for the given ID.
 * 404 if not found.
 */
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

    return NextResponse.json({ snapshot });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to get snapshot", detail: message },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/snapshots/[id]
 *
 * Deletes a snapshot by ID.
 * Returns 200 with deleted: true, or 404 if not found.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await params;
    const deleted = deleteSnapshot(id);

    if (!deleted) {
      return NextResponse.json(
        { error: "Snapshot not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ deleted: true, id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to delete snapshot", detail: message },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/snapshots/[id]
 *
 * Update snapshot metadata (label, description).
 * Body (JSON):
 *   label        — optional new label
 *   description  — optional new description
 */
export async function PATCH(
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

    const label = typeof body.label === "string" ? body.label : undefined;
    const description = typeof body.description === "string" ? body.description : undefined;

    if (label !== undefined && !label.trim()) {
      return NextResponse.json(
        { error: "Label cannot be empty" },
        { status: 400 }
      );
    }

    const updates: { label?: string; description?: string } = {};
    if (label !== undefined) updates.label = label.trim();
    if (description !== undefined) updates.description = description;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: "No updatable fields provided (label, description)" },
        { status: 400 }
      );
    }

    const updated = updateSnapshotMeta(id, updates);

    if (!updated) {
      return NextResponse.json(
        { error: "Snapshot not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ updated: true, id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to update snapshot", detail: message },
      { status: 500 }
    );
  }
}
