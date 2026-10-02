/**
 * Load and parse a VS Code .code-workspace file.
 *
 * - Handles JSON-with-comments via jsonc.ts
 * - Resolves relative paths against the workspace file's directory
 * - Validates folder entries (duplicates, missing paths)
 * - Returns a WorkspaceDefinition
 */

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, resolve, isAbsolute, basename } from "node:path";
import { parseJSONC } from "./jsonc";
import type { WorkspaceDefinition, WorkspaceFolder } from "./types";

/** Internal shape of the raw .code-workspace JSON */
interface RawWorkspaceFile {
  folders?: (
    | string
    | { name?: string; path: string }
  )[];
  settings?: Record<string, unknown>;
  extensions?: { recommendations?: string[] };
}

/**
 * Load and parse a .code-workspace file.
 *
 * @param filePath — absolute path to the .code-workspace file
 * @returns a validated WorkspaceDefinition
 * @throws if the file cannot be read or parsed
 */
export function loadWorkspaceFile(filePath: string): WorkspaceDefinition {
  const absPath = resolve(filePath);
  const baseDir = dirname(absPath);

  if (!existsSync(absPath)) {
    throw new Error(`Workspace file not found: ${absPath}`);
  }

  const raw = readFileSync(absPath, "utf-8");
  const data = parseJSONC<RawWorkspaceFile>(raw);

  const rawFolders: RawWorkspaceFile["folders"] = data.folders ?? [];
  const folders: WorkspaceFolder[] = [];
  const seen = new Set<string>();

  for (const entry of rawFolders) {
    let rawPath: string;
    let folderName: string | undefined;

    if (typeof entry === "string") {
      rawPath = entry;
    } else if (entry && typeof entry === "object") {
      rawPath = entry.path;
      folderName = entry.name;
    } else {
      continue; // skip invalid entries
    }

    // Resolve relative paths against the workspace file's directory
    const resolvedPath = isAbsolute(rawPath)
      ? rawPath
      : resolve(baseDir, rawPath);

    // Canonicalise (resolve symlinks) if the path exists
    const canonicalPath =
      existsSync(resolvedPath) ? realpathSync(resolvedPath) : resolvedPath;

    // Deduplicate by canonical path
    if (seen.has(canonicalPath)) continue;
    seen.add(canonicalPath);

    const name =
      folderName ?? basename(canonicalPath);

    folders.push({
      name,
      rawPath,
      resolvedPath: canonicalPath,
      exists: existsSync(resolvedPath),
    });
  }

  const wsName = basename(absPath).replace(/\.code-workspace$/i, "") || "Untitled";

  return {
    filePath: absPath,
    name: wsName,
    folders,
    settings: data.settings,
    extensions: data.extensions,
  };
}
