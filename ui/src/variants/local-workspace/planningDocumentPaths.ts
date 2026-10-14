import type { WorkspacePlanningDocumentDescriptor, WorkspacePlanningDocumentId } from "../../lib/wtsClient";

export interface PlanningDocumentLink {
  documentId: WorkspacePlanningDocumentId;
  hash?: string;
}

const MAX_PATH_LENGTH = 4096;
const controls = /[\u0000-\u001f\u007f]/;
const scheme = /^[a-z][a-z\d+.-]*:/i;

function relativePath(path: string, parent: readonly string[] = []): string | undefined {
  if (!path || path.length > MAX_PATH_LENGTH || path.startsWith("/") || path.includes("\\") || controls.test(path) || scheme.test(path)) return undefined;
  const segments = [...parent];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return undefined;
      segments.pop();
    } else segments.push(segment);
  }
  return segments.length ? segments.join("/") : undefined;
}

function descriptorPath(fileName: string): string | undefined {
  if (!fileName || fileName.length > MAX_PATH_LENGTH || controls.test(fileName)) return undefined;
  // Older hosts and fixtures used absolute file names. Their parent paths are not link authority.
  if (fileName.startsWith("/") || /^[a-z]:[\\/]/i.test(fileName) || fileName.startsWith("\\\\")) {
    return relativePath(fileName.split(/[\\/]/).pop() ?? "");
  }
  return relativePath(fileName);
}

export function planningDocumentDisplayPath(fileName: string): string {
  return descriptorPath(fileName) ?? "Planning file";
}

export function resolvePlanningDocumentLink(
  documents: readonly WorkspacePlanningDocumentDescriptor[],
  current: WorkspacePlanningDocumentDescriptor,
  href: string,
): PlanningDocumentLink | undefined {
  if (!href || href.length > MAX_PATH_LENGTH || controls.test(href) || href.includes("\\")) return undefined;
  const link = href.trim();
  const hashIndex = link.indexOf("#");
  const rawPath = hashIndex === -1 ? link : link.slice(0, hashIndex);
  const hash = hashIndex === -1 ? undefined : link.slice(hashIndex);
  if (!rawPath || rawPath.includes("?") || rawPath.startsWith("/") || scheme.test(rawPath) || /%2f|%5c/i.test(rawPath)) return undefined;

  let path: string;
  try {
    path = decodeURIComponent(rawPath);
    // Decode file names once. Encoded separators, traversal, and a second encoding are ambiguous.
    if (/%[a-f\d]{2}/i.test(path)) return undefined;
    if (rawPath.split("/").some(segment => {
      const decoded = decodeURIComponent(segment);
      return segment !== decoded && (decoded === "." || decoded === "..");
    })) return undefined;
    if (hash && (controls.test(decodeURIComponent(hash)) || decodeURIComponent(hash).includes("\\"))) return undefined;
  } catch { return undefined; }

  const currentPath = descriptorPath(current.fileName);
  if (!currentPath || !documents.some(document => document.documentId === current.documentId && document.fileName === current.fileName)) return undefined;
  const targetPath = relativePath(path, currentPath.split("/").slice(0, -1));
  if (!targetPath) return undefined;
  const matches = documents.filter(document => descriptorPath(document.fileName) === targetPath);
  if (matches.length !== 1) return undefined;
  const target = matches[0]!;
  if (documents.filter(document => document.documentId === target.documentId).length !== 1) return undefined;
  return { documentId: target.documentId, ...(hash && hash !== "#" ? { hash } : {}) };
}
