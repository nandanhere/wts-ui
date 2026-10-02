import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const defaultRoot = resolve(scriptDirectory, "..");
const rootArgumentIndex = process.argv.indexOf("--root");
const projectRoot =
  rootArgumentIndex >= 0 && process.argv[rootArgumentIndex + 1]
    ? resolve(process.argv[rootArgumentIndex + 1])
    : defaultRoot;

const forbiddenTrackedPaths = [
  /^\.env(?:\.|$)/,
  /^\.agents(?:\/|$)/,
  /^\.codex(?:\/|$)/,
  /^\.wts(?:\/|$)/,
  /^graphify-out(?:\/|$)/,
  /(?:^|\/)\.DS_Store$/,
  /\.(?:app\.tar\.gz|dmg|key|p12|pfx|pem|private-key)$/i,
];

const allowedEnvironmentFiles = new Set([
  ".env.example",
  ".env.sample",
  ".env.test.example",
]);
const exampleAccounts = new Set(["example", "test", "runner", "Shared"]);

function candidateFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: projectRoot },
  );
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

function textContent(file) {
  const absolutePath = resolve(projectRoot, file);
  const relativePath = relative(projectRoot, absolutePath);
  if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    return null;
  }
  const content = readFileSync(absolutePath);
  if (content.includes(0)) return null;
  return content.toString("utf8");
}

function lineNumber(content, index) {
  return content.slice(0, index).split("\n").length;
}

function addMatches(violations, file, content, rule, expression, validate) {
  for (const match of content.matchAll(expression)) {
    if (validate && !validate(match)) continue;
    violations.push({ file, line: lineNumber(content, match.index), rule });
  }
}

export function auditRepository() {
  const violations = [];
  for (const file of candidateFiles()) {
    if (
      !allowedEnvironmentFiles.has(file) &&
      forbiddenTrackedPaths.some((expression) => expression.test(file))
    ) {
      violations.push({ file, line: 1, rule: "private or generated file" });
    }

    const content = textContent(file);
    if (content === null) continue;

    addMatches(
      violations,
      file,
      content,
      "personal macOS path",
      /\/Users\/([A-Za-z0-9._-]+)(?=\/)/g,
      (match) => !exampleAccounts.has(match[1]),
    );

    addMatches(
      violations,
      file,
      content,
      "non-example email address",
      /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
      (match) => {
        const account = match[1].toLowerCase();
        const domain = match[2].toLowerCase();
        const lineStart = content.lastIndexOf("\n", match.index) + 1;
        const linePrefix = content.slice(lineStart, match.index);
        if (/https?:\/\/[^/\s]*$/.test(linePrefix)) return false;
        if (account === "git" && ["github.com", "gitlab.com"].includes(domain)) {
          return false;
        }
        return !(
          ["example.com", "example.org", "example.net"].includes(domain) ||
          domain.endsWith(".example") ||
          domain.endsWith(".example.com") ||
          domain.endsWith(".example.org") ||
          domain.endsWith(".example.net") ||
          domain.endsWith(".test") ||
          domain.endsWith(".invalid")
        );
      },
    );
    addMatches(
      violations,
      file,
      content,
      "personal Linux path",
      /\/home\/([A-Za-z0-9._-]+)(?=\/)/g,
      (match) => !exampleAccounts.has(match[1]),
    );
    addMatches(
      violations,
      file,
      content,
      "personal Windows path",
      /[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)(?=\\)/g,
      (match) => !exampleAccounts.has(match[1]),
    );

    const privateKeyWords = ["BEGIN", "PRIVATE", "KEY"];
    const privateKeyExpression = new RegExp(privateKeyWords.join("[ _-]+"), "g");
    addMatches(
      violations,
      file,
      content,
      "private key material",
      privateKeyExpression,
    );

    const credentialPrefixes = [
      ["gh", "p_"].join(""),
      ["github", "_pat_"].join(""),
      ["glpat", "-"].join(""),
      ["xox", "b-"].join(""),
      ["xox", "p-"].join(""),
    ];
    for (const prefix of credentialPrefixes) {
      const expression = new RegExp(`${prefix}[A-Za-z0-9_-]{16,}`, "g");
      addMatches(violations, file, content, "credential-like value", expression);
    }

    const secretEnvironmentNames = [
      "ANTHROPIC_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "GITLAB_ACCESS_TOKEN",
      "GITLAB_TOKEN",
      "OPENAI_API_KEY",
      "WTS_OPENPROJECT_TOKEN",
    ];
    const assignmentExpression = new RegExp(
      `(?:${secretEnvironmentNames.join("|")})\\s*[:=]\\s*["']?([^\\s"']{8,})`,
      "g",
    );
    addMatches(
      violations,
      file,
      content,
      "secret environment assignment",
      assignmentExpression,
      (match) => {
        const value = match[1].toLowerCase();
        return !(
          value.startsWith("$") ||
          ["dummy", "example", "fake", "redacted", "replace", "test"].some(
            (marker) => value.includes(marker),
          )
        );
      },
    );
  }
  return violations;
}

function main() {
  const violations = auditRepository();
  if (violations.length === 0) {
    process.stdout.write("Open-source readiness audit passed.\n");
    return;
  }

  process.stderr.write("Open-source readiness audit failed:\n");
  for (const violation of violations) {
    process.stderr.write(
      `- ${violation.file}:${violation.line} (${violation.rule})\n`,
    );
  }
  process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
