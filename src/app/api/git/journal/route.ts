/**
 * GET /api/git/journal — list recent audit journal entries.
 *
 * Query params:
 *   limit — max entries to return (default 100, max 500)
 *
 * Read-only. Returns structured journal entries with no secrets.
 *
 * DELETE /api/git/journal — clear all journal entries.
 * Requires action token.
 */

import { NextRequest, NextResponse } from "next/server";
import { listJournalEntries, clearJournal } from "@/lib/git/journal";
import { verifyActionToken } from "@/lib/git/action-token";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const limitParam = request.nextUrl.searchParams.get("limit");
    const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || 100), 500) : 100;

    const entries = listJournalEntries(limit);
    return NextResponse.json({ entries, count: entries.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to read journal", detail: message },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest): Promise<Response> {
  try {
    const token = request.headers.get("x-action-token") ?? "";
    if (!verifyActionToken(token)) {
      return NextResponse.json({ error: "Missing or invalid action token" }, { status: 403 });
    }

    clearJournal();
    return NextResponse.json({ cleared: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to clear journal", detail: message },
      { status: 500 }
    );
  }
}
