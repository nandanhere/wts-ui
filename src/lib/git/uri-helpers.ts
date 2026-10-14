/**
 * Pure helper functions for VS Code URI encoding and branch/ref display.
 *
 * These functions have zero side effects and no dependencies on the git runner,
 * making them straightforward to unit test.
 */

/* ------------------------------------------------------------------ */
/*  VS Code file:// URI helpers                                        */
/* ------------------------------------------------------------------ */

/**
 * Encode a local path into a `vscode://file/{path}` URI.
 *
 * The authority segment is always empty; the path portion is
 * URI-encoded so that spaces, special characters, and non-ASCII
 * names survive transport.
 *
 * @param absolutePath — An absolute filesystem path (platform-native separators).
 * @returns A `vscode://file/...` URI string suitable for use in an anchor href
 *          or programmatic window.open call.
 *
 * @example
 *   createVSCodeFileUri("/Users/example/my project/main.ts")
 *   // → "vscode://file/Users/example/my%20project/main.ts"
 */
export function createVSCodeFileUri(absolutePath: string): string {
  // Normalise away any trailing slash and strip scheme prefix if present
  let clean = absolutePath.replace(/\/+$/, "");
  if (clean.startsWith("file://")) {
    clean = clean.slice("file://".length);
  }
  // Remove leading slash so path joins as relative — vscode://file/abs/path
  const noLeadingSlash = clean.startsWith("/") ? clean.slice(1) : clean;
  const encodedPath = noLeadingSlash
    .split(/[\\/]/)
    .map(encodeURIComponent)
    .join("/");
  return `vscode://file/${encodedPath}`;
}

/* ------------------------------------------------------------------ */
/*  Ref display helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * Human-readable short name from a full ref string.
 *
 * @example
 *   displayRef("refs/remotes/origin/feature/foo")
 *   // → "origin/feature/foo"
 *   displayRef("refs/heads/main")
 *   // → "main"
 *   displayRef("main")
 *   // → "main"
 */
export function displayRef(ref: string): string {
  if (ref.startsWith("refs/remotes/")) {
    return ref.slice("refs/remotes/".length);
  }
  if (ref.startsWith("refs/heads/")) {
    return ref.slice("refs/heads/".length);
  }
  return ref;
}

/**
 * Extract just the branch name portion from a remote tracking ref.
 *
 * @example
 *   remoteBranchName("refs/remotes/origin/feature/foo")
 *   // → "feature/foo"
 *   remoteBranchName("origin/feature/foo")
 *   // → "feature/foo"
 */
export function remoteBranchName(ref: string): string {
  const withoutPrefix = ref.startsWith("refs/remotes/")
    ? ref.slice("refs/remotes/".length)
    : ref;
  const slashIdx = withoutPrefix.indexOf("/");
  return slashIdx === -1 ? withoutPrefix : withoutPrefix.slice(slashIdx + 1);
}

/**
 * Decide whether a ref string represents a remote tracking ref.
 */
export function isRemoteRef(ref: string): boolean {
  return ref.startsWith("refs/remotes/");
}

/** Normalize a displayed remote ref into the explicit form required by preflight. */
export function normalizeSwitchInput(
  input: string,
  knownRemotes: string[]
): { target: string; createTracking: boolean } {
  if (isRemoteRef(input)) return { target: input, createTracking: true };
  const remote = knownRemotes.find((name) => input.startsWith(`${name}/`));
  return remote
    ? { target: `refs/remotes/${input}`, createTracking: true }
    : { target: input, createTracking: false };
}
