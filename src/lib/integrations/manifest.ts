/**
 * Workspace manifest builder — constructs the curated manifest from the
 * integration registry and the authoritative workspace context.
 *
 * - Per-provider failures degrade to a compact unavailable entry
 *   with a safe error code/message (no exception strings or paths).
 * - Stable provider order is preserved.
 * - Response is kept low-noise and bounded (max 20 provider entries).
 */

import type {
  IntegrationProvider,
  WorkspaceIntegrationContext,
  ProviderManifestEntry,
  WorkspaceManifest,
  ProviderState,
} from "./types";
import { IntegrationProviderUnavailable } from "./types";
import type { IntegrationRegistry } from "./registry";
import { sanitizeBlocks, sanitizeString } from "./sanitizer";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Maximum number of provider entries in a manifest. */
const MAX_PROVIDERS = 20;

/* ------------------------------------------------------------------ */
/*  Safe error codes                                                   */
/* ------------------------------------------------------------------ */

type SafeErrorCode =
  | "UNEXPECTED_ERROR"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_ERROR"
  | "PROVIDER_DEGRADED";

/** Stable classification — never uses exception message substring matching. */
function classifyProviderError(err: unknown): SafeErrorCode {
  if (err instanceof IntegrationProviderUnavailable) {
    return "PROVIDER_UNAVAILABLE";
  }
  return "UNEXPECTED_ERROR";
}

/** Produce a degraded manifest entry from a provider failure. */
function degradedEntry(
  provider: IntegrationProvider,
  errorCode: SafeErrorCode
): ProviderManifestEntry {
  return {
    id: provider.id,
    name: sanitizeString(provider.name),
    description: sanitizeString(provider.description),
    state: "unavailable",
    capabilities: [...provider.capabilities],
    riskLevel: provider.riskLevel,
    tools: provider.tools.map((t) => ({
      id: sanitizeString(t.id, 80),
      label: sanitizeString(t.label, 120),
      description: sanitizeString(t.description, 300),
      requiresApproval: t.requiresApproval,
      risk: t.risk,
    })),
    blocks: [
      {
        type: "notice",
        id: `${provider.id}-error`,
        title: "Unavailable",
        message: "This integration encountered an error and is unavailable.",
        severity: "error",
      },
    ],
    errorCode,
    errorMessage: "Provider error — check integration health.",
  };
}

/* ------------------------------------------------------------------ */
/*  getState return validation                                         */
/* ------------------------------------------------------------------ */

const VALID_STATES: ReadonlySet<string> = new Set<ProviderState>([
  "available",
  "unavailable",
  "degraded",
]);

function validateProviderState(value: unknown): ProviderState {
  if (typeof value === "string" && VALID_STATES.has(value)) {
    return value as ProviderState;
  }
  // Invalid runtime state — treat as provider failure
  throw new IntegrationProviderUnavailable(
    "Provider returned invalid runtime state"
  );
}

/* ------------------------------------------------------------------ */
/*  Manifest builder                                                   */
/* ------------------------------------------------------------------ */

/**
 * Build the complete workspace manifest for the current context.
 *
 * @param registry - The immutable integration registry.
 * @param ctx      - Authoritative workspace context (server-side only).
 * @returns A deterministic, bounded manifest.
 */
export async function buildManifest(
  registry: IntegrationRegistry,
  ctx: WorkspaceIntegrationContext
): Promise<WorkspaceManifest> {
  const entries: ProviderManifestEntry[] = [];

  for (const provider of registry.providers) {
    // Cap total provider entries
    if (entries.length >= MAX_PROVIDERS) break;

    try {
      // Determine state
      let state: ProviderState = "available";
      if (typeof provider.getState === "function") {
        state = validateProviderState(
          await Promise.resolve(provider.getState(ctx))
        );
      }

      if (state === "unavailable") {
        entries.push({
          id: provider.id,
          name: sanitizeString(provider.name),
          description: sanitizeString(provider.description),
          state: "unavailable",
          capabilities: [...provider.capabilities],
          riskLevel: provider.riskLevel,
          tools: provider.tools.map((t) => ({
            id: sanitizeString(t.id, 80),
            label: sanitizeString(t.label, 120),
            description: sanitizeString(t.description, 300),
            requiresApproval: t.requiresApproval,
            risk: t.risk,
          })),
          blocks: [
            {
              type: "notice",
              id: `${provider.id}-unavailable`,
              title: "Unavailable",
              message:
                "This integration is not available in the current workspace context.",
              severity: "info",
            },
          ],
          errorCode: "PROVIDER_UNAVAILABLE",
        });
        continue;
      }

      // Get blocks
      const blocks = await Promise.resolve(provider.getBlocks(ctx));

      // Sanitize all provider-returned values
      const sanitizedBlocks = sanitizeBlocks(blocks);

      const entry: ProviderManifestEntry = {
        id: provider.id,
        name: sanitizeString(provider.name),
        description: sanitizeString(provider.description),
        state: state === "degraded" ? "degraded" : "available",
        capabilities: [...provider.capabilities],
        riskLevel: provider.riskLevel,
        tools: provider.tools.map((t) => ({
          id: sanitizeString(t.id, 80),
          label: sanitizeString(t.label, 120),
          description: sanitizeString(t.description, 300),
          requiresApproval: t.requiresApproval,
          risk: t.risk,
        })),
        blocks: sanitizedBlocks,
      };

      if (state === "degraded") {
        entry.errorCode = "PROVIDER_DEGRADED";
        entry.errorMessage = "Integration is operating in degraded mode.";
      }

      entries.push(entry);
    } catch (err) {
      // Provider threw unexpectedly — degrade gracefully
      const code = classifyProviderError(err);
      entries.push(degradedEntry(provider, code));
    }
  }

  return {
    workspaceName: sanitizeString(ctx.workspaceName, 200),
    generatedAt: new Date().toISOString(),
    providers: entries,
  };
}
