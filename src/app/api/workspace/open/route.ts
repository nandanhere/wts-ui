/**
 * GET /api/workspace/open?path=<encoded-path>
 *
 * Opens/loads a .code-workspace file, discovers its folders and
 * Git repositories, updates the registry, and returns the full
 * scan result.
 *
 * Read-only discovery.  No mutations of repositories.
 * Accepts both absolute paths and paths relative to HOME (~).
 */

import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { loadWorkspaceFile } from "@/lib/workspace/parser";
import { scanWorkspace } from "@/lib/workspace/discovery";
import { upsertRegistryEntry } from "@/lib/workspace/registry";
import { registerRepos } from "@/lib/git/registry";
import type { WorkspaceDefinition } from "@/lib/workspace/types";

export const dynamic = "force-dynamic";

/**
 * Validate that an extensionless path pointing to a non-dir
 * looks like a .code-workspace file, and that its resolved
 * path is not trying to escape the user's homedir or /etc,
 * etc.
 */
function validatePath(rawPath: string): string | null {
  let resolved: string;

  // Expand ~
  if (rawPath.startsWith("~/") || rawPath === "~") {
    resolved = resolve(homedir(), rawPath.slice(1));
  } else if (isAbsolute(rawPath)) {
    resolved = resolve(rawPath);
  } else {
    return null; // relative paths not allowed
  }

  // Must end with .code-workspace (case-insensitive for macOS)
  if (!/\.code-workspace$/i.test(resolved)) {
    return null;
  }

  // Must exist and be a file
  if (!existsSync(resolved)) {
    return null;
  }

  return resolved;
}

export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const rawPath = request.nextUrl.searchParams.get("path");
    if (!rawPath) {
      return NextResponse.json(
        { error: "Missing required query parameter: path" },
        { status: 400 }
      );
    }

    const resolvedPath = validatePath(rawPath);
    if (!resolvedPath) {
      return NextResponse.json(
        {
          error: "Invalid path: must be an absolute path to a .code-workspace file",
        },
        { status: 400 }
      );
    }

    let ws: WorkspaceDefinition;
    try {
      ws = loadWorkspaceFile(resolvedPath);
    } catch (parseErr) {
      return NextResponse.json(
        {
          error: "Failed to parse workspace file",
          detail: parseErr instanceof Error ? parseErr.message : String(parseErr),
        },
        { status: 422 }
      );
    }

    const scanResult = scanWorkspace(ws);
    registerRepos(scanResult.repositories, scanResult.workspace.filePath);

    // Record in registry (even if some folders had errors)
    try {
      upsertRegistryEntry(
        resolvedPath,
        ws.name,
        ws.folders.length,
        scanResult.repositories.length
      );
    } catch {
      // Non-fatal: registry write should not break the response
    }

    return NextResponse.json({
      workspace: ws,
      repositories: scanResult.repositories,
      scanErrors: scanResult.errors,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Internal error", detail: message },
      { status: 500 }
    );
  }
}
