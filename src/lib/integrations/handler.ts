/**
 * Integration handler — testable, dependency-injected route logic.
 *
 * Separated from the Next.js route so unit tests can run without
 * importing `next/server`.
 */

import { isSameOriginRequest } from "@/lib/git/request-security";
import { getOpenedWorkspaceFilePath, getAllRepos } from "@/lib/git/registry";
import { IntegrationRegistry } from "@/lib/integrations/registry";
import { buildManifest } from "@/lib/integrations/manifest";
import { buildContext } from "@/lib/integrations/context";
import { BUILT_IN_PROVIDERS } from "@/lib/integrations/providers";
import type { IntegrationRegistry as IntegrationRegistryType } from "@/lib/integrations/registry";

/* ------------------------------------------------------------------ */
/*  Dependency shape for testability                                   */
/* ------------------------------------------------------------------ */

export interface RouteDeps {
  isSameOrigin: (req: { headers: { get(name: string): string | null } }) => boolean;
  getOpenedFile: () => string | null;
  getAllRepos: () => unknown[];
  getRegistry: () => IntegrationRegistryType;
  buildContext: (
    openedFilePath: string | null,
    repos: unknown[],
    workspaceName?: string
  ) => ReturnType<typeof buildContext>;
  buildManifest: (
    registry: IntegrationRegistryType,
    ctx: NonNullable<ReturnType<typeof buildContext>>
  ) => ReturnType<typeof buildManifest>;
  jsonResponse: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => Response;
}

/* ------------------------------------------------------------------ */
/*  Singleton registry                                                 */
/* ------------------------------------------------------------------ */

let registry: IntegrationRegistryType | null = null;

function getRegistry(): IntegrationRegistryType {
  if (!registry) {
    registry = IntegrationRegistry.create({ providers: [...BUILT_IN_PROVIDERS] });
  }
  return registry;
}

/* ------------------------------------------------------------------ */
/*  Default dependencies (production)                                  */
/* ------------------------------------------------------------------ */

export function createDefaultDeps(jsonResponse: RouteDeps["jsonResponse"]): RouteDeps {
  return {
    isSameOrigin: (req) => isSameOriginRequest(req as Parameters<typeof isSameOriginRequest>[0]),
    getOpenedFile: () => getOpenedWorkspaceFilePath(),
    getAllRepos: () => getAllRepos(),
    getRegistry,
    buildContext: (file, repos) =>
      buildContext(file, repos as Parameters<typeof buildContext>[1]),
    buildManifest: (reg, ctx) => buildManifest(reg, ctx),
    jsonResponse,
  };
}

/* ------------------------------------------------------------------ */
/*  Shared handler (testable — dependency injected)                    */
/* ------------------------------------------------------------------ */

export async function handleIntegrationsGet(
  request: { headers: { get(name: string): string | null } },
  deps: RouteDeps
): Promise<Response> {
  // 1. Require same-origin
  if (!deps.isSameOrigin(request)) {
    return deps.jsonResponse(
      { error: "Cross-origin requests are not allowed" },
      { status: 403 }
    );
  }

  try {
    // 2. Get authoritative workspace context from server-side registry
    const openedFilePath = deps.getOpenedFile();
    const repos = deps.getAllRepos();

    if (!openedFilePath) {
      return deps.jsonResponse(
        {
          error: "No workspace is currently open. Open a workspace first.",
          code: "NO_WORKSPACE",
        },
        { status: 409 }
      );
    }

    if (repos.length === 0) {
      return deps.jsonResponse(
        {
          error:
            "Workspace has no registered repositories. Open a workspace with Git repositories.",
          code: "NO_REPOSITORIES",
        },
        { status: 409 }
      );
    }

    // 3. Build context and manifest
    const ctx = deps.buildContext(openedFilePath, repos);
    if (!ctx) {
      return deps.jsonResponse(
        { error: "Failed to build workspace context", code: "CONTEXT_ERROR" },
        { status: 500 }
      );
    }

    const manifest = await deps.buildManifest(deps.getRegistry(), ctx);

    return deps.jsonResponse(manifest);
  } catch {
    // No raw exception detail in API response
    return deps.jsonResponse(
      {
        error: "Failed to build integration manifest",
        code: "MANIFEST_ERROR",
      },
      { status: 500 }
    );
  }
}
