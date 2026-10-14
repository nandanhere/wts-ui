/**
 * GET /api/integrations — workspace integration manifest.
 *
 * Returns the curated manifest for the currently opened workspace.
 * No query parameters.  Requires same-origin (via @/lib/git/request-security).
 * Returns 409 if no authoritative workspace/repos exist.
 * Returns 500 with a safe error code (no raw exception detail) on failure.
 *
 * This is the ONLY integrations endpoint.  All provider data flows
 * through the server-side manifest builder.
 *
 * Providers, capabilities, and tool descriptors are deep-cloned and frozen
 * at registry construction time. Duplicate tool IDs, capabilities, and
 * bound descriptor violations (non-readonly without approval) are rejected.
 * Unknown block types are replaced with safe bounded fallback notices.
 */

import { NextRequest, NextResponse } from "next/server";
import { handleIntegrationsGet, createDefaultDeps } from "@/lib/integrations/handler";

export const dynamic = "force-dynamic";

const deps = createDefaultDeps((body, init) => NextResponse.json(body, init));

export async function GET(request: NextRequest): Promise<Response> {
  return handleIntegrationsGet(request, deps);
}
