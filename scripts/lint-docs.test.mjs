import assert from "node:assert/strict";
import test from "node:test";

import { lintMarkdown } from "./lint-docs.mjs";

test("reports semicolons, contractions, and disallowed words in prose", () => {
  const issues = lintMarkdown(
    "This is robust; it should not fail.\nIt isn't ready.\nWe leverage the cache.\n",
  );

  assert.deepEqual(issues, [
    { line: 1, rule: "no-semicolon" },
    { line: 1, rule: "plain-word" },
    { line: 2, rule: "no-contraction" },
    { line: 3, rule: "plain-word" },
  ]);
});

test("ignores code fences, inline code, and link destinations", () => {
  const issues = lintMarkdown([
    "<!-- BEGIN:generated-rules -->",
    "Use `left; right` as the exact value.",
    "Read the [source](https://example.test/a;b).",
    "```text",
    "This isn't prose; leverage it.",
    "```",
  ].join("\n"));

  assert.deepEqual(issues, []);
});

test("checks prose after a fenced code block", () => {
  const issues = lintMarkdown("~~~sh\necho \\\"a;b\\\"\n~~~\nDo not utilize it.\n");

  assert.deepEqual(issues, [{ line: 4, rule: "plain-word" }]);
});

test("does not report possessive nouns as contractions", () => {
  const issues = lintMarkdown("The developer's workspace uses WTS's catalog.\n");

  assert.deepEqual(issues, []);
});

test("reports the upstream phrasal verbs, hedges, and marketing words", () => {
  const issues = lintMarkdown([
    "Spin up the powerful service.",
    "It should be noted that the check can fail.",
    "Use the state-of-the-art scanner.",
  ].join("\n"));

  assert.deepEqual(issues, [
    { line: 1, rule: "plain-word" },
    { line: 1, rule: "direct-verb" },
    { line: 2, rule: "no-modal-hedge" },
    { line: 3, rule: "plain-word" },
  ]);
});
