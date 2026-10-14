/**
 * Tests for pure URI/ref helper functions.
 *
 * Run: node --experimental-strip-types --test src/lib/git/__tests__/uri-helpers.test.ts
 */

import { describe, it } from "node:test";
import { strictEqual } from "node:assert";
import {
  createVSCodeFileUri,
  displayRef,
  remoteBranchName,
  isRemoteRef,
  normalizeSwitchInput,
} from "../uri-helpers";

void describe("createVSCodeFileUri", () => {
  void it("encodes a simple absolute path", () => {
    const result = createVSCodeFileUri("/Users/example/project");
    strictEqual(result, "vscode://file/Users/example/project");
  });

  void it("encodes spaces in path", () => {
    const result = createVSCodeFileUri("/Users/example/my project/src");
    strictEqual(result, "vscode://file/Users/example/my%20project/src");
  });

  void it("encodes reserved URI characters in path segments", () => {
    const result = createVSCodeFileUri("/path/with+plus/and%percent/file.ts");
    strictEqual(
      result,
      "vscode://file/path/with%2Bplus/and%25percent/file.ts"
    );
  });

  void it("encodes query and fragment delimiters", () => {
    strictEqual(
      createVSCodeFileUri("/tmp/a#b/c?d"),
      "vscode://file/tmp/a%23b/c%3Fd"
    );
  });

  void it("strips trailing slash", () => {
    const result = createVSCodeFileUri("/Users/example/project/");
    strictEqual(result, "vscode://file/Users/example/project");
  });

  void it("strips file:// prefix if present", () => {
    const result = createVSCodeFileUri("file:///Users/example/project");
    strictEqual(result, "vscode://file/Users/example/project");
  });

  void it("handles empty string gracefully", () => {
    const result = createVSCodeFileUri("");
    strictEqual(result, "vscode://file/");
  });
});

void describe("displayRef", () => {
  void it("strips refs/remotes/ prefix", () => {
    strictEqual(
      displayRef("refs/remotes/origin/main"),
      "origin/main"
    );
  });

  void it("strips refs/heads/ prefix", () => {
    strictEqual(displayRef("refs/heads/main"), "main");
  });

  void it("preserves nested remote refs", () => {
    strictEqual(
      displayRef("refs/remotes/origin/feature/foo"),
      "origin/feature/foo"
    );
  });

  void it("returns plain string unchanged", () => {
    strictEqual(displayRef("main"), "main");
    strictEqual(displayRef("origin/main"), "origin/main");
  });
});

void describe("remoteBranchName", () => {
  void it("extracts branch from full remote ref", () => {
    strictEqual(
      remoteBranchName("refs/remotes/origin/feature/foo"),
      "feature/foo"
    );
  });

  void it("extracts branch from origin/main", () => {
    strictEqual(
      remoteBranchName("refs/remotes/origin/main"),
      "main"
    );
  });

  void it("handles short form origin/branch", () => {
    strictEqual(remoteBranchName("origin/feature/x"), "feature/x");
  });

  void it("returns plain name when no slash", () => {
    strictEqual(remoteBranchName("main"), "main");
  });
});

void describe("isRemoteRef", () => {
  void it("returns true for refs/remotes/ prefixed", () => {
    strictEqual(isRemoteRef("refs/remotes/origin/main"), true);
  });

  void it("returns false for refs/heads/ prefixed", () => {
    strictEqual(isRemoteRef("refs/heads/main"), false);
  });

  void it("returns false for plain name", () => {
    strictEqual(isRemoteRef("main"), false);
  });
});

void describe("normalizeSwitchInput", () => {
  void it("converts a displayed remote branch into an explicit tracking ref", () => {
    strictEqual(
      JSON.stringify(normalizeSwitchInput("origin/feature/x", ["origin"])),
      JSON.stringify({ target: "refs/remotes/origin/feature/x", createTracking: true })
    );
  });

  void it("preserves local branch names", () => {
    strictEqual(
      JSON.stringify(normalizeSwitchInput("feature/x", ["origin"])),
      JSON.stringify({ target: "feature/x", createTracking: false })
    );
  });
});
