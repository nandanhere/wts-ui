#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DISALLOWED_WORDS = [
  "seamless",
  "seamlessly",
  "robust",
  "powerful",
  "cutting-edge",
  "effortless",
  "effortlessly",
  "world-class",
  "next-generation",
  "revolutionary",
  "blazing",
  "lightning-fast",
  "elegant",
  "delightful",
  "turnkey",
  "best-in-class",
  "state-of-the-art",
  "game-changing",
  "first-class",
  "battle-tested",
  "enterprise-grade",
  "supercharge",
  "unlock",
  "unleash",
  "empower",
  "empowers",
  "begin",
  "begins",
  "utilize",
  "utilizes",
  "utilized",
  "utilizing",
  "leveraging",
  "leverage",
  "leverages",
  "leveraged",
  "facilitate",
  "facilitates",
  "facilitated",
  "commence",
  "commences",
  "commenced",
  "initiate",
  "initiates",
  "initiated",
  "originate",
  "prior to",
  "subsequent",
  "subsequent to",
  "obtain",
  "obtains",
  "acquire",
  "acquires",
  "demonstrate",
  "demonstrates",
  "additionally",
  "furthermore",
  "moreover",
  "comprehensive",
  "comprehensively",
  "utilization",
  "aforementioned",
  "henceforth",
  "therein",
  "whilst",
  "amongst",
  "numerous",
  "myriad",
  "plethora",
  "in order to",
  "a variety of",
  "in the event that",
  "due to the fact that",
  "it is important to note",
];

const PHRASAL_VERBS = [
  "spin up",
  "spin down",
  "reach out",
  "dive into",
  "dives into",
  "diving into",
  "kick off",
  "kicks off",
  "roll out",
  "rolls out",
  "tear down",
  "ramp up",
  "circle back",
  "drill down",
  "spun up",
  "reaching out",
];

const MODAL_HEDGES = [
  "it is important to note",
  "it should be noted",
  "it is worth noting",
  "please note that",
  "as mentioned",
  "as noted above",
];

const DISALLOWED_WORD_PATTERN = new RegExp(
  `\\b(?:${DISALLOWED_WORDS.map(escapePattern).join("|")})\\b`,
  "i",
);
const PHRASAL_VERB_PATTERN = new RegExp(
  `\\b(?:${PHRASAL_VERBS.map(escapePattern).join("|")})\\b`,
  "i",
);
const MODAL_HEDGE_PATTERN = new RegExp(
  `\\b(?:${MODAL_HEDGES.map(escapePattern).join("|")})\\b`,
  "i",
);
const CONTRACTIONS = [
  "can't",
  "couldn't",
  "didn't",
  "doesn't",
  "don't",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "won't",
  "wouldn't",
  "shouldn't",
  "it's",
  "that's",
  "there's",
  "they're",
  "we're",
  "you're",
  "they've",
  "we've",
  "you've",
  "they'll",
  "we'll",
  "you'll",
  "i'm",
  "i've",
  "i'll",
];
const CONTRACTION_PATTERN = new RegExp(
  `\\b(?:${CONTRACTIONS.join("|").replaceAll("'", "['’]")})\\b`,
  "i",
);

function stripInlineCodeAndLinks(line) {
  let text = line.replace(/<!--.*?-->/g, "");
  text = text.replace(/`+[^`]*`+/g, "");
  text = text.replace(/\]\([^)]*\)/g, "]");
  return text;
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function lintRestrictedTerms(source) {
  const issues = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (DISALLOWED_WORD_PATTERN.test(line)) {
      issues.push({ line: index + 1, rule: "plain-word" });
    }
    if (PHRASAL_VERB_PATTERN.test(line)) {
      issues.push({ line: index + 1, rule: "direct-verb" });
    }
    if (MODAL_HEDGE_PATTERN.test(line)) {
      issues.push({ line: index + 1, rule: "no-modal-hedge" });
    }
  }
  return issues;
}

export function lintMarkdown(source) {
  const issues = [];
  let fence = null;

  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      fence = fence === marker ? null : marker;
      continue;
    }
    if (fence) continue;

    const prose = stripInlineCodeAndLinks(line);
    if (prose.includes(";")) {
      issues.push({ line: index + 1, rule: "no-semicolon" });
    }
    if (CONTRACTION_PATTERN.test(prose)) {
      issues.push({ line: index + 1, rule: "no-contraction" });
    }
    if (DISALLOWED_WORD_PATTERN.test(prose)) {
      issues.push({ line: index + 1, rule: "plain-word" });
    }
    if (PHRASAL_VERB_PATTERN.test(prose)) {
      issues.push({ line: index + 1, rule: "direct-verb" });
    }
    if (MODAL_HEDGE_PATTERN.test(prose)) {
      issues.push({ line: index + 1, rule: "no-modal-hedge" });
    }
  }

  return issues;
}

function projectMarkdownFiles() {
  const output = execFileSync("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "*.md",
    "*.mdx",
    ":(exclude)graphify-out/**",
    ":(exclude)test-results/**",
  ]);
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function main() {
  const failures = [];
  for (const file of projectMarkdownFiles()) {
    const issues = lintMarkdown(readFileSync(file, "utf8"));
    for (const issue of issues) {
      failures.push(`${file}:${issue.line} ${issue.rule}`);
    }
  }

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    console.error(`Documentation style check failed with ${failures.length} issue(s).`);
    process.exitCode = 1;
    return;
  }

  console.log("Documentation style check passed.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
