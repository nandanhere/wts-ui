#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { lintRestrictedTerms } from "./lint-docs.mjs";

function interfaceSourceFiles() {
  const output = execFileSync("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "ui/src/**/*.tsx",
    ":(exclude)ui/src/**/*.test.tsx",
  ]);
  return output.toString("utf8").split("\0").filter(Boolean);
}

const failures = [];
for (const file of interfaceSourceFiles()) {
  for (const issue of lintRestrictedTerms(readFileSync(file, "utf8"))) {
    failures.push(`${file}:${issue.line} ${issue.rule}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  console.error(`Interface writing check failed with ${failures.length} issue(s).`);
  process.exitCode = 1;
} else {
  console.log("Interface writing check passed.");
}
