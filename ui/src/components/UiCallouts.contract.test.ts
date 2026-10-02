import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

describe("UI callout source contract", () => {
  it("pairs each machine ID with a spoken label and keeps literals unique", () => {
    const annotations = sourceFiles(join(process.cwd(), "src")).flatMap(
      (file) => {
        const source = readFileSync(file, "utf8");
        return Array.from(
          source.matchAll(/<[A-Za-z][^>]*\bdata-ui=(?:"[^"]+"|\{[^>]+\})[^>]*>/g),
          (match) => {
            const tag = match[0];
            return {
              file,
              id: tag.match(/\bdata-ui="([^"]+)"/)?.[1],
              label: tag.match(/\bdata-ui-label="([^"]+)"/)?.[1],
              hasLabel: /\bdata-ui-label=(?:"[^"]+"|\{[^>]+\})/.test(tag),
            };
          },
        );
      },
    );

    expect(annotations.length).toBeGreaterThan(0);
    expect(
      annotations.filter(({ hasLabel }) => !hasLabel).map(({ file, id }) => ({
        file,
        id,
      })),
    ).toEqual([]);
    const literalIds = annotations.flatMap(({ id }) => (id ? [id] : []));
    const literalLabels = annotations.flatMap(({ label }) =>
      label ? [label] : [],
    );
    expect(new Set(literalIds).size).toBe(literalIds.length);
    expect(new Set(literalLabels).size).toBe(literalLabels.length);
  });
});
