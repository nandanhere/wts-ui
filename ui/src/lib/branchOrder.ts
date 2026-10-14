const usualBases = ["main", "master", "develop", "development", "trunk", "staging"];

const nameOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Puts the default branch first, then the usual base branches, then the rest by name without case. */
export function orderBaseBranches<Branch extends { name: string }>(
  branches: readonly Branch[],
  defaultBranchName?: string | null,
): Branch[] {
  const rank = (name: string) => {
    if (name === defaultBranchName) return -1;
    const usual = usualBases.indexOf(name);
    return usual === -1 ? usualBases.length : usual;
  };
  return [...branches].sort(
    (left, right) => rank(left.name) - rank(right.name) || nameOrder.compare(left.name, right.name),
  );
}

/**
 * The base value to send for a branch. A local branch and an origin branch can have the same name.
 * The origin one then uses `origin/<name>`, which the server resolves to `refs/remotes/origin/<name>`.
 */
export function baseBranchValue(
  branch: { name: string; remote?: boolean },
  branches: readonly { name: string; remote?: boolean }[],
): string {
  return branch.remote && branches.some((other) => !other.remote && other.name === branch.name)
    ? `origin/${branch.name}`
    : branch.name;
}
