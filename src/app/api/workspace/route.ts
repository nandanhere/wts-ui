/**
 * GET /api/workspace — list recently opened workspaces from registry.
 *
 * Read-only. No auth, no mutations. Returns the registry entries
 * sorted most-recently-opened first.
 */

import { NextResponse } from "next/server";
import { listRegistryEntries } from "@/lib/workspace/registry";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const entries = listRegistryEntries();
    return NextResponse.json({ entries });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to read registry", detail: message },
      { status: 500 }
    );
  }
}
