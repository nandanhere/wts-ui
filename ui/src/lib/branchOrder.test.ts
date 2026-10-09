import { describe, expect, it } from "vitest";
import { baseBranchValue, orderBaseBranches } from "./branchOrder";

const branches = (...names: string[]) => names.map((name) => ({ name }));

describe("orderBaseBranches", () => {
  it("puts the default branch and the usual bases first, then sorts the rest without case", () => {
    const ordered = orderBaseBranches(
      branches("DEVTOOLS-6409", "automation/x", "develop", "Zeta", "release/10", "main", "release/9", "DEVTOOLS-5920", "master"),
      "master",
    );
    expect(ordered.map((branch) => branch.name)).toEqual([
      "master",
      "main",
      "develop",
      "automation/x",
      "DEVTOOLS-5920",
      "DEVTOOLS-6409",
      "release/9",
      "release/10",
      "Zeta",
    ]);
  });

  it("works without a default branch and does not change the input", () => {
    const input = branches("b", "develop", "A");
    expect(orderBaseBranches(input).map((branch) => branch.name)).toEqual(["develop", "A", "b"]);
    expect(input.map((branch) => branch.name)).toEqual(["b", "develop", "A"]);
  });
});

describe("baseBranchValue", () => {
  const catalog = [
    { name: "develop", remote: false },
    { name: "develop", remote: true },
    { name: "main", remote: true },
  ];

  it("gives an origin branch with a local twin its own origin/ value", () => {
    expect(catalog.map((branch) => baseBranchValue(branch, catalog))).toEqual(["develop", "origin/develop", "main"]);
  });
});
