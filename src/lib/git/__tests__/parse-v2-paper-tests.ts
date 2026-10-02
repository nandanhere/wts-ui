/**
 * Paper (disposable-repo-free) tests for porcelain v2 parsing.
 *
 * Tests parsePorcelainV2 directly with constructed NUL-delimited and
 * newline-delimited inputs — no git subprocesses needed.
 *
 * Run: node --experimental-strip-types --loader ./scripts/register-ts.mjs --test src/lib/git/__tests__/parse-v2-paper-tests.ts
 */

import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert";
import { parsePorcelainV2, changedFile } from "../status";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const BRANCH_NL = [
  "# branch.oid a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b",
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +2 -1",
].join("\n") + "\n";

const BRANCH_NL_CLEAN = [
  "# branch.oid a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b",
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +0 -0",
].join("\n") + "\n";

const BRANCH_DETACHED = [
  "# branch.oid a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b",
  "# branch.head (detached)",
  "# branch.ab +0 -0",
].join("\n") + "\n";

/** Build NUL-delimited stdout: branch block + file entries joined by \0 */
function nulStdout(lines: string[]): string {
  return lines.join("\0");
}

/** Build newline-delimited stdout (no -z mode) */
function nlStdout(lines: string[]): string {
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

void describe("parsePorcelainV2 — branch info", () => {
  void it("parses branch header with ahead/behind", () => {
    const v2 = parsePorcelainV2(BRANCH_NL.trim());
    ok(v2 !== null, "should parse");
    strictEqual(v2.branch.headOid, "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b");
    strictEqual(v2.branch.ref, "refs/heads/main");
    strictEqual(v2.branch.upstream, "origin/main");
    strictEqual(v2.branch.ahead, 2);
    strictEqual(v2.branch.behind, 1);
    strictEqual(v2.files.length, 0);
  });

  void it("parses detached HEAD", () => {
    const v2 = parsePorcelainV2(BRANCH_DETACHED.trim());
    ok(v2 !== null);
    strictEqual(v2.branch.ref, "(detached)");
    strictEqual(v2.branch.upstream, "");
    strictEqual(v2.branch.ahead, 0);
    strictEqual(v2.branch.behind, 0);
  });

  void it("returns null for empty input", () => {
    strictEqual(parsePorcelainV2(""), null);
    strictEqual(parsePorcelainV2("   "), null);
  });
});

void describe("parsePorcelainV2 — NUL-delimited (git -z mode)", () => {
  void it("parses NUL-delimited staged change", () => {
    const stdout = nulStdout([
      BRANCH_NL_CLEAN.trim(),
      "1 M. N... 100644 100644 100644 abc123 def456 src/index.ts",
    ]);
    const v2 = parsePorcelainV2(stdout);
    ok(v2 !== null);
    strictEqual(v2.staged, 1);
    strictEqual(v2.unstaged, 0);
    strictEqual(v2.untracked, 0);
    strictEqual(v2.files.length, 1);
    const f = v2.files[0]!;
    strictEqual(f.path, "src/index.ts");
    strictEqual(f.xy, "M.");
    strictEqual(f.staged, true);
    strictEqual(f.unstaged, false);
    strictEqual(f.stage, "index");
  });

  void it("parses NUL-delimited unstaged change", () => {
    const stdout = nulStdout([
      BRANCH_NL_CLEAN.trim(),
      "1 .M N... 100644 100644 100644 abc123 def456 src/styles.css",
    ]);
    const v2 = parsePorcelainV2(stdout);
    ok(v2 !== null);
    strictEqual(v2.unstaged, 1);
    strictEqual(v2.staged, 0);
    const f = v2.files[0]!;
    strictEqual(f.path, "src/styles.css");
    strictEqual(f.xy, ".M");
    strictEqual(f.staged, false);
    strictEqual(f.unstaged, true);
    strictEqual(f.stage, "worktree");
  });

  void it("parses NUL-delimited both staged and unstaged (MM)", () => {
    const stdout = nulStdout([
      BRANCH_NL_CLEAN.trim(),
      "1 MM N... 100644 100644 100644 abc123 def456 src/app.ts",
    ]);
    const v2 = parsePorcelainV2(stdout);
    ok(v2 !== null);
    strictEqual(v2.staged, 1);
    strictEqual(v2.unstaged, 1);
    strictEqual(v2.files.length, 1);
    const f = v2.files[0]!;
    strictEqual(f.path, "src/app.ts");
    strictEqual(f.xy, "MM");
    strictEqual(f.staged, true);
    strictEqual(f.unstaged, true);
    // stage is "index" (index takes priority when both)
    strictEqual(f.stage, "index");
  });

  void it("parses NUL-delimited path with spaces", () => {
    const stdout = nulStdout([
      BRANCH_NL_CLEAN.trim(),
      "1 .M N... 100644 100644 100644 abc123 def456 my file with spaces.txt",
    ]);
    const v2 = parsePorcelainV2(stdout);
    ok(v2 !== null);
    strictEqual(v2.files.length, 1);
    strictEqual(v2.files[0]!.path, "my file with spaces.txt");
  });

  void it("parses NUL-delimited rename (type 2 entry)", () => {
    // Format: 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
    const stdout = nulStdout([
      BRANCH_NL_CLEAN.trim(),
      "2 R. N... 100644 100644 100644 abc123 def456 R100 new-name.txt",
      "old-name.txt",
    ]);
    const v2 = parsePorcelainV2(stdout);
    ok(v2 !== null);
    strictEqual(v2.files.length, 1);
    const f = v2.files[0]!;
    strictEqual(f.path, "new-name.txt");
    strictEqual(f.origPath, "old-name.txt");
    strictEqual(f.xy, "R.");
    strictEqual(f.staged, true);
    strictEqual(f.unstaged, false);
  });

  void it("parses NUL-delimited rename with spaces in both paths", () => {
    const stdout = nulStdout([
      BRANCH_NL_CLEAN.trim(),
      "2 R. N... 100644 100644 100644 abc123 def456 R100 new file name.js",
      "old file name.js",
    ]);
    const v2 = parsePorcelainV2(stdout);
    ok(v2 !== null);
    strictEqual(v2.files.length, 1);
    const f = v2.files[0]!;
    strictEqual(f.path, "new file name.js");
    strictEqual(f.origPath, "old file name.js");
  });

  void it("parses NUL-delimited untracked file", () => {
    // Porcelain v2 -z emits a single ? for untracked
    const stdout = nulStdout([
      BRANCH_NL_CLEAN.trim(),
      "? untracked.txt",
    ]);
    const v2 = parsePorcelainV2(stdout);
    ok(v2 !== null);
    strictEqual(v2.untracked, 1);
    strictEqual(v2.staged, 0);
    strictEqual(v2.unstaged, 0);
    strictEqual(v2.files.length, 1);
    const f = v2.files[0]!;
    strictEqual(f.path, "untracked.txt");
    strictEqual(f.xy, "??");
    strictEqual(f.staged, false);
    strictEqual(f.unstaged, false);
    strictEqual(f.stage, "untracked");
  });

  void it("parses NUL-delimited untracked dir/file path", () => {
    const stdout = nulStdout([
      BRANCH_NL_CLEAN.trim(),
      "? src/new-module/index.ts",
    ]);
    const v2 = parsePorcelainV2(stdout);
    ok(v2 !== null);
    strictEqual(v2.untracked, 1);
    strictEqual(v2.files[0]!.path, "src/new-module/index.ts");
  });

  void it("parses NUL-delimited conflicted file (type u entry)", () => {
    // Format: u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
    const stdout = nulStdout([
      BRANCH_NL_CLEAN.trim(),
      "u UU N... 100644 100644 100644 100644 abc123 def456 a1b2c3 src/conflict.ts",
    ]);
    const v2 = parsePorcelainV2(stdout);
    ok(v2 !== null);
    strictEqual(v2.conflicted, 1);
    strictEqual(v2.files.length, 1);
    const f = v2.files[0]!;
    strictEqual(f.path, "src/conflict.ts");
    strictEqual(f.xy, "UU");
    strictEqual(f.conflicted, true);
    strictEqual(f.staged, false);
    strictEqual(f.unstaged, false);
  });

  void it("parses NUL-delimited multiple changes simultaneously", () => {
    const stdout = nulStdout([
      BRANCH_NL_CLEAN.trim(),
      "1 M. N... 100644 100644 100644 abc111 def111 staged.txt",
      "1 .M N... 100644 100644 100644 abc222 def222 unstaged.txt",
      "1 MM N... 100644 100644 100644 abc333 def333 both.txt",
      "2 R. N... 100644 100644 100644 abc444 def444 R100 renamed.py",
      "old_name.py",
      "? new_file.txt",
      "u UU N... 100644 100644 100644 100644 abc555 def555 aaa555 conflict.md",
    ]);
    const v2 = parsePorcelainV2(stdout);
    ok(v2 !== null);
    strictEqual(v2.staged, 3, "staged.txt + both.txt + renamed.py"); // M., MM, R.
    strictEqual(v2.unstaged, 2, "unstaged.txt + both.txt");         // .M, MM
    strictEqual(v2.untracked, 1);
    strictEqual(v2.conflicted, 1);
    strictEqual(v2.files.length, 6, "6 entries (rename consumes NUL field for origPath)");
    strictEqual(v2.files.filter(f => f.origPath !== undefined).length, 1, "only the rename has origPath");
    strictEqual(v2.branch.ref, "refs/heads/main");
  });
});

void describe("parsePorcelainV2 — newline-delimited (no -z mode)", () => {
  void it("parses NL-delimited staged change", () => {
    const stdout = nlStdout([
      BRANCH_NL_CLEAN.trim(),
      "1 M. N... 100644 100644 100644 abc123 def456 file.ts",
      "",
    ]);
    const v2 = parsePorcelainV2(stdout);
    ok(v2 !== null);
    strictEqual(v2.staged, 1);
    strictEqual(v2.files[0]!.path, "file.ts");
  });

  void it("parses NL-delimited rename with tab separator", () => {
    const stdout = nlStdout([
      BRANCH_NL_CLEAN.trim(),
      "2 R. N... 100644 100644 100644 abc123 def456 R100 new-name.txt\told-name.txt",
      "",
    ]);
    const v2 = parsePorcelainV2(stdout);
    ok(v2 !== null);
    strictEqual(v2.files.length, 1);
    const f = v2.files[0]!;
    strictEqual(f.path, "new-name.txt");
    strictEqual(f.origPath, "old-name.txt");
  });

  void it("parses NL-delimited untracked", () => {
    // Porcelain v2 (non -z) also uses single ? for untracked
    const stdout = nlStdout([
      BRANCH_NL_CLEAN.trim(),
      "? untracked.md",
      "",
    ]);
    const v2 = parsePorcelainV2(stdout);
    ok(v2 !== null);
    strictEqual(v2.untracked, 1);
    strictEqual(v2.files[0]!.path, "untracked.md");
  });
});

void describe("changedFile helper", () => {
  void it("marks stagged and unstaged booleans correctly", () => {
    // Staged only
    const staged = changedFile("M.", ".", "file.ts");
    strictEqual(staged.staged, true);
    strictEqual(staged.unstaged, false);
    strictEqual(staged.conflicted, false);
    strictEqual(staged.stage, "index");

    // Unstaged only
    const unstaged = changedFile(".M", ".", "file.ts");
    strictEqual(unstaged.staged, false);
    strictEqual(unstaged.unstaged, true);
    strictEqual(unstaged.stage, "worktree");

    // Both
    const both = changedFile("MM", ".", "file.ts");
    strictEqual(both.staged, true);
    strictEqual(both.unstaged, true);
    strictEqual(both.stage, "index");

    // Untracked
    const untracked = changedFile("??", ".", "file.ts");
    strictEqual(untracked.staged, false);
    strictEqual(untracked.unstaged, false);
    strictEqual(untracked.conflicted, false);
    strictEqual(untracked.stage, "untracked");
  });

  void it("sets origPath when provided", () => {
    const f = changedFile("R.", ".", "new.ts", "old.ts");
    strictEqual(f.origPath, "old.ts");
    strictEqual(f.path, "new.ts");
  });

  void it("does not set origPath when absent", () => {
    const f = changedFile("M.", ".", "file.ts");
    strictEqual(f.origPath, undefined);
  });

  void it("marks conflicted when parameter is true", () => {
    const f = changedFile("UU", ".", "file.ts", undefined, true);
    strictEqual(f.conflicted, true);
    strictEqual(f.staged, false);
    strictEqual(f.unstaged, false);
  });
});

void describe("parsePorcelainV2 — edge cases", () => {
  void it("handles files with special characters in path (no -z)", () => {
    const stdout = nlStdout([
      BRANCH_NL_CLEAN.trim(),
      "1 M. N... 100644 100644 100644 abc123 def456 src/[test]/file.js",
      "",
    ]);
    const v2 = parsePorcelainV2(stdout);
    ok(v2 !== null);
    strictEqual(v2.files.length, 1);
    strictEqual(v2.files[0]!.path, "src/[test]/file.js");
    strictEqual(v2.files[0]!.xy, "M.");
  });

  void it("parses branch info from NUL-delimited stdout", () => {
    const stdout = nulStdout([
      BRANCH_NL.trim(),
      "1 M. N... 100644 100644 100644 abc123 def456 file.ts",
    ]);
    const v2 = parsePorcelainV2(stdout);
    ok(v2 !== null);
    strictEqual(v2.branch.ahead, 2);
    strictEqual(v2.branch.behind, 1);
    strictEqual(v2.branch.upstream, "origin/main");
  });
});
