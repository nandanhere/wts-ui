import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Interface text must not use WTS as the subject of a sentence.
// Progress text uses the -ing form, for example "Checking GitLab…".
const SOURCE_ROOT = join(__dirname, "..");
const AUXILIARIES = "can|cannot|could|did|does|do|has|had|is|was|were|will|would|should|must|may|kept|keeps|found|finds|stopped|stops";
// Nouns that can follow WTS as a compound, such as "WTS controls" or "WTS plans".
const NOUNS = new Set(["controls", "plans", "artifacts", "workspaces", "workstreams", "surfaces", "settings", "sessions", "tools", "users", "files", "windows", "tasks", "rules", "reviews"]);
const SUBJECT = new RegExp(`\\bWTS (?:(?:${AUXILIARIES})\\b|([a-z]+(?:s|ed))\\b)`, "g");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.includes("Fixture") ? [path] : [];
  });
}

export function findWtsSubjectSentences(source: string): string[] {
  const hits: string[] = [];
  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    for (const match of line.matchAll(SUBJECT)) {
      const verb = match[1];
      if (verb && NOUNS.has(verb)) continue;
      hits.push(`${index + 1}: ${trimmed}`);
    }
  });
  return hits;
}

describe("interface voice", () => {
  it("flags WTS as a sentence subject and allows progress text", () => {
    expect(findWtsSubjectSentences('const a = "WTS checks GitLab";')).toHaveLength(1);
    expect(findWtsSubjectSentences('const a = "WTS could not read the file.";')).toHaveLength(1);
    expect(findWtsSubjectSentences('const a = "Checking GitLab…";')).toEqual([]);
    expect(findWtsSubjectSentences('<span data-ui-label="WTS controls" />')).toEqual([]);
  });

  it("keeps WTS out of the subject position in shipped interface text", () => {
    const offenders = sourceFiles(SOURCE_ROOT).flatMap((file) =>
      findWtsSubjectSentences(readFileSync(file, "utf8")).map((hit) => `${relative(SOURCE_ROOT, file)}:${hit}`),
    );
    expect(offenders).toEqual([]);
  });
});

