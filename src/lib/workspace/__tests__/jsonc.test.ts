/**
 * Tests for the JSONC parser.
 * Run: node --experimental-strip-types --test src/lib/workspace/__tests__/jsonc.test.ts
 */

import { describe, it } from "node:test";
import { ok, strictEqual } from "node:assert";
import { parseJSONC } from "../jsonc";

void describe("parseJSONC", () => {
  void it("parses plain JSON", () => {
    const result = parseJSONC<{ a: number }>('{"a": 1}');
    strictEqual(result.a, 1);
  });

  void it("strips line comments", () => {
    const result = parseJSONC<{ a: number }>('{"a": 1 // comment\n}');
    strictEqual(result.a, 1);
  });

  void it("strips block comments", () => {
    const result = parseJSONC<{ a: number }>('{"a": /* block */ 1}');
    strictEqual(result.a, 1);
  });

  void it("strips multi-line block comments", () => {
    const result = parseJSONC<{ a: number }>(
      '{"a": /* multi\n   line */ 1}'
    );
    strictEqual(result.a, 1);
  });

  void it("strips trailing commas in arrays", () => {
    const result = parseJSONC<number[]>("[1, 2, 3,]");
    strictEqual(result.length, 3);
    strictEqual(result[0], 1);
    strictEqual(result[2], 3);
  });

  void it("strips trailing commas in objects", () => {
    const result = parseJSONC<{ a: number; b: number }>('{"a": 1, "b": 2,}');
    strictEqual(result.a, 1);
    strictEqual(result.b, 2);
  });

  void it("handles .code-workspace style — comments + trailing commas", () => {
    const raw = `{
      "folders": [
        { "name": "foo", "path": "./foo" },
        { "name": "bar", "path": "./bar" }, // trailing
      ],
      "settings": {
        "files.exclude": { "**/.git": false }, // comment
        /* block comment */
      },
    }`;
    const result = parseJSONC<{
      folders: { name: string; path: string }[];
    }>(raw);
    ok(Array.isArray(result.folders));
    strictEqual(result.folders.length, 2);
    strictEqual(result.folders[1].name, "bar");
  });

  void it("handles empty objects", () => {
    const result = parseJSONC<Record<string, never>>("{}");
    strictEqual(Object.keys(result).length, 0);
  });

  void it("handles nested comments", () => {
    const raw = `{
      /* outer */
      "nested": { /* inner */ "a": 1 }
    }`;
    const result = parseJSONC<{ nested: { a: number } }>(raw);
    strictEqual(result.nested.a, 1);
  });

  void it("throws on invalid JSON after cleaning", () => {
    ok.throws(() => parseJSONC("{invalid}"));
  });

  void it("handles strings containing slashes (URLs)", () => {
    const raw = `{"url": "https://example.com/api/v1"}`;
    const result = parseJSONC<{ url: string }>(raw);
    strictEqual(result.url, "https://example.com/api/v1");
  });

  void it("handles string containing // inside a string", () => {
    const raw = `{"path": "foo/bar/baz"}`;
    const result = parseJSONC<{ path: string }>(raw);
    strictEqual(result.path, "foo/bar/baz");
  });

  void it("handles empty object with only comments", () => {
    const raw = `{
      // comment
      /* block */
    }`;
    const result = parseJSONC<Record<string, never>>(raw);
    strictEqual(Object.keys(result).length, 0);
  });
});
