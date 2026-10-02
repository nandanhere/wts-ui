/**
 * Tests for the config inventory scanner.
 *
 * All tests use disposable temporary directories and never touch real repos.
 *
 * Run: node --experimental-strip-types --loader ../../../scripts/register-ts.mjs \
 *       --test src/lib/config-inventory/__tests__/scanner.test.ts
 */

import { describe, it, before, after } from "node:test";
import { strictEqual, ok, deepStrictEqual, notStrictEqual } from "node:assert";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
  mkdtempSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { scanRepository, scanRepositories } from "@/lib/config-inventory/scanner";
import type { ConfigFileMetadata } from "@/lib/config-inventory/types";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

let baseTmp: string;

function tmpDir(): string {
  const dir = mkdtempSync(join(baseTmp, "cfg-inv-"));
  // Resolve symlinks for predictable realpath
  return realpathSync(dir);
}

function write(base: string, relPath: string, content = ""): void {
  const abs = join(base, relPath);
  const dir = relPath.includes("/") ? resolve(abs, "..") : base;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

/* ------------------------------------------------------------------ */
/*  Setup / teardown                                                  */
/* ------------------------------------------------------------------ */

before(() => {
  baseTmp = mkdtempSync(join(tmpdir(), "cfg-inv-base-"));
});

after(() => {
  if (existsSync(baseTmp)) rmSync(baseTmp, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/*  Basic discovery                                                    */
/* ------------------------------------------------------------------ */

void describe("scanRepository — basic discovery", () => {
  void it("discovers YAML config files", () => {
    const root = tmpDir();
    write(root, "config.yaml", "key: value\n");
    write(root, "app.yml", "app: test\n");
    write(root, "README.md", "not a config file\n");

    const result = scanRepository("repo-a", root);
    strictEqual(result.files.length, 2);
    ok(result.files.some((f) => f.repoRelativePath === "config.yaml"));
    ok(result.files.some((f) => f.repoRelativePath === "app.yml"));
    strictEqual(result.truncated, false);
  });

  void it("discovers JSON config files", () => {
    const root = tmpDir();
    write(root, "appsettings.json", "{}");
    write(root, ".prettierrc", '{"tabWidth": 2}');

    const result = scanRepository("repo-b", root);
    const jsonFiles = result.files.filter((f) => f.kind === "json");
    ok(jsonFiles.length >= 1);
  });

  void it("discovers TOML files", () => {
    const root = tmpDir();
    write(root, "Cargo.toml", '[package]\nname = "test"\n');
    write(root, "pyproject.toml", '[tool.poetry]\nname = "x"\n');

    const result = scanRepository("repo-c", root);
    const tomlFiles = result.files.filter((f) => f.kind === "toml");
    strictEqual(tomlFiles.length, 2);
  });

  void it("discovers Docker Compose files", () => {
    const root = tmpDir();
    write(root, "docker-compose.yaml", "services:\n  app:\n");
    write(root, "compose.prod.yml", "services:\n  web:\n");

    const result = scanRepository("repo-d", root);
    const composeFiles = result.files.filter((f) => f.kind === "docker-compose");
    strictEqual(composeFiles.length, 2);
  });

  void it("discovers Helm chart and Kubernetes files", () => {
    const root = tmpDir();
    write(root, "Chart.yaml", "apiVersion: v2\n");
    write(root, "values.yaml", "replicaCount: 1\n");
    write(root, "kustomization.yaml", "resources:\n  - deployment.yaml\n");

    const result = scanRepository("repo-e", root);
    const helmFiles = result.files.filter((f) => f.kind === "helm-chart");
    strictEqual(helmFiles.length, 2);
    const kustomizeFiles = result.files.filter((f) => f.kind === "kubernetes");
    strictEqual(kustomizeFiles.length, 1);
  });

  void it("discovers GitLab CI and GitHub CI files", () => {
    const root = tmpDir();
    write(root, ".gitlab-ci.yml", "stages:\n  - test\n");
    const wfDir = join(root, ".github", "workflows");
    mkdirSync(wfDir, { recursive: true });
    write(wfDir, "ci.yml", "name: CI\n");

    const result = scanRepository("repo-f", root);
    const gitlab = result.files.filter((f) => f.kind === "gitlab-ci");
    strictEqual(gitlab.length, 1);
    strictEqual(gitlab[0]!.repoRelativePath, ".gitlab-ci.yml");
  });

  void it("discovers env example files", () => {
    const root = tmpDir();
    write(root, ".env.example", "PORT=3000\n");
    write(root, ".env.local", "SECRET=xxx\n");
    write(root, "env.example", "DB_HOST=localhost\n");

    const result = scanRepository("repo-g", root);
    const envExample = result.files.filter((f) => f.kind === "env-example");
    const dotenv = result.files.filter((f) => f.kind === "dotenv");
    strictEqual(envExample.length, 2); // .env.example + env.example
    strictEqual(dotenv.length, 1); // .env.local
  });
});

/* ------------------------------------------------------------------ */
/*  Exclusion patterns                                                 */
/* ------------------------------------------------------------------ */

void describe("scanRepository — exclusions", () => {
  void it("excludes node_modules directory", () => {
    const root = tmpDir();
    write(root, "config.yaml", "root: true\n");
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    write(join(root, "node_modules", "pkg"), "config.yaml", "ignored: true\n");

    const result = scanRepository("repo-h", root);
    strictEqual(result.files.length, 1);
    strictEqual(result.files[0]!.repoRelativePath, "config.yaml");
  });

  void it("excludes .git directory", () => {
    const root = tmpDir();
    mkdirSync(join(root, ".git"), { recursive: true });
    write(join(root, ".git"), "config", "[core]\n");
    write(root, "app.yaml", "ok: true\n");

    const result = scanRepository("repo-i", root);
    strictEqual(result.files.length, 1);
    ok(result.files.every((f) => !f.repoRelativePath.startsWith(".git")));
  });

  void it("excludes graphify-out directory", () => {
    const root = tmpDir();
    write(root, "config.yaml", "root: true\n");
    mkdirSync(join(root, "graphify-out"), { recursive: true });
    write(join(root, "graphify-out"), "report.json", '{"nodes": []}\n');

    const result = scanRepository("repo-j", root);
    strictEqual(result.files.length, 1);
    strictEqual(result.files[0]!.repoRelativePath, "config.yaml");
  });

  void it("excludes dependency and build directories", () => {
    const root = tmpDir();
    write(root, "root.yaml", "ok: true\n");
    for (const dir of ["vendor", "dist", "build", "target", "__pycache__", ".next"]) {
      mkdirSync(join(root, dir), { recursive: true });
      write(join(root, dir), "config.yaml", `# ${dir} config\n`);
    }

    const result = scanRepository("repo-k", root);
    strictEqual(result.files.length, 1);
  });

  void it("accepts custom exclude patterns", () => {
    const root = tmpDir();
    write(root, "config.yaml", "root: true\n");
    mkdirSync(join(root, "internal"), { recursive: true });
    write(join(root, "internal"), "secrets.yaml", "password: x\n");

    const result = scanRepository("repo-l", root, {
      excludeDirPatterns: ["^internal$"],
    });

    strictEqual(result.files.length, 1);
    strictEqual(result.files[0]!.repoRelativePath, "config.yaml");
  });
});

/* ------------------------------------------------------------------ */
/*  Limit enforcement                                                  */
/* ------------------------------------------------------------------ */

void describe("scanRepository — limit enforcement", () => {
  void it("caps traversal depth", () => {
    const root = tmpDir();
    write(root, "l0.yaml", "l0\n");
    let dir = root;
    for (let i = 1; i <= 12; i++) {
      dir = join(dir, `sub${i}`);
      mkdirSync(dir, { recursive: true });
      write(dir, `l${i}.yaml`, `l${i}\n`);
    }

    // Default maxDepth is 8 — should find l0 + l1..l8 = 9 files at most
    const result = scanRepository("repo-m", root);
    // l0 found at depth 0, l1 at depth 1, ..., l8 at depth 8
    const surface = result.files.filter((f) => f.repoRelativePath.startsWith("l"));
    ok(surface.length <= 9, `Expected ≤ 9 files at default depth, got ${surface.length}`);
  });

  void it("caps max files", () => {
    const root = tmpDir();
    for (let i = 0; i < 30; i++) {
      write(root, `cfg${i}.yaml`, `key: value-${i}\n`);
    }

    const result = scanRepository("repo-n", root, {
      limits: { maxFiles: 10 },
    });

    strictEqual(result.files.length, 10);
    strictEqual(result.truncated, true);
  });

  void it("caps per-file bytes for fingerprinting", () => {
    const root = tmpDir();
    // Write a file larger than maxFileBytes
    const bigContent = "x".repeat(10_000);
    write(root, "config.yaml", bigContent);

    const result = scanRepository("repo-o", root, {
      limits: { maxFileBytes: 100 },
    });

    strictEqual(result.files.length, 1);
    // Fingerprint should be deterministic but only of first 100 bytes
    strictEqual(result.files[0]!.fingerprint.length, 64); // SHA-256 hex
  });

  void it("caps total bytes", () => {
    const root = tmpDir();
    for (let i = 0; i < 20; i++) {
      write(root, `cfg${i}.yaml`, "a".repeat(5_000));
    }

    const result = scanRepository("repo-p", root, {
      limits: { totalBytes: 15_000 },
    });

    ok(result.files.length <= 3, `Expected at most 3 files within 15 KB, got ${result.files.length}`);
    strictEqual(result.truncated, true);
  });

  void it("does not follow file or directory symlinks", () => {
    const root = tmpDir();
    const outside = tmpDir();
    write(root, "local.yaml", "local: true\n");
    write(outside, "outside.yaml", "outside: true\n");
    symlinkSync(join(outside, "outside.yaml"), join(root, "linked.yaml"));
    symlinkSync(outside, join(root, "linked-dir"));

    const result = scanRepository("repo-symlink", root);

    deepStrictEqual(
      result.files.map((file) => file.repoRelativePath),
      ["local.yaml"]
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Secret-name detection                                              */
/* ------------------------------------------------------------------ */

void describe("scanRepository — secret detection", () => {
  void it("marks files with secret in name", () => {
    const root = tmpDir();
    write(root, "secrets.yaml", "password: x\n");
    write(root, "config.yaml", "normal: true\n");

    const result = scanRepository("repo-q", root);

    const secret = result.files.find((f) => f.repoRelativePath === "secrets.yaml");
    ok(secret, "secrets.yaml should be discovered");
    strictEqual(secret!.probableSecret, true);
    strictEqual(secret!.fingerprint, "", "suspected secrets must not be fingerprinted");

    const normal = result.files.find((f) => f.repoRelativePath === "config.yaml");
    ok(normal, "config.yaml should be discovered");
    strictEqual(normal!.probableSecret, false);
  });

  void it("detects secrets by multiple name patterns", () => {
    const root = tmpDir();
    const secretFiles = [
      "password.yml",
      "credentials.json",
      "api-key.yaml",
      "auth.toml",
      ".env.production",
      "private-key.pem",
      "tokens.yaml",
    ];
    const normalFiles = [
      "settings.yaml",
      "app.json",
      "config.toml",
    ];

    for (const f of [...secretFiles, ...normalFiles]) {
      write(root, f, "content\n");
    }

    const result = scanRepository("repo-r", root);

    for (const sf of secretFiles) {
      const entry = result.files.find((f) => f.repoRelativePath === sf);
      ok(entry, `${sf} should be discovered`);
      strictEqual(entry!.probableSecret, true, `${sf} should be marked as probable secret`);
    }

    for (const nf of normalFiles) {
      const entry = result.files.find((f) => f.repoRelativePath === nf);
      ok(entry, `${nf} should be discovered`);
      strictEqual(entry!.probableSecret, false, `${nf} should NOT be marked as probable secret`);
    }
  });

  void it("detects .vault extension as secret", () => {
    const root = tmpDir();
    write(root, "passwords.vault", "ANSIBLE_VAULT;1.1\n");
    write(root, "config.yaml", "normal\n");

    const result = scanRepository("repo-s", root);
    const vault = result.files.find((f) => f.repoRelativePath === "passwords.vault");
    ok(vault);
    strictEqual(vault!.probableSecret, true);
  });
});

/* ------------------------------------------------------------------ */
/*  Deterministic fingerprinting                                      */
/* ------------------------------------------------------------------ */

void describe("scanRepository — deterministic fingerprints", () => {
  void it("produces same fingerprint for same content", () => {
    const rootA = tmpDir();
    const rootB = tmpDir();
    write(rootA, "config.yaml", "key: value\n");
    write(rootB, "config.yaml", "key: value\n");

    const resultA = scanRepository("repo-ta", rootA);
    const resultB = scanRepository("repo-tb", rootB);

    strictEqual(resultA.files[0]!.fingerprint, resultB.files[0]!.fingerprint);
  });

  void it("produces different fingerprints for different content", () => {
    const rootA = tmpDir();
    const rootB = tmpDir();
    write(rootA, "config.yaml", "key: value\n");
    write(rootB, "config.yaml", "key: different\n");

    const resultA = scanRepository("repo-ua", rootA);
    const resultB = scanRepository("repo-ub", rootB);

    notStrictEqual(resultA.files[0]!.fingerprint, resultB.files[0]!.fingerprint);
  });

  void it("fingerprint is SHA-256 hex (64 chars)", () => {
    const root = tmpDir();
    write(root, "config.yaml", "hello world\n");

    const result = scanRepository("repo-v", root);
    strictEqual(result.files.length, 1);
    strictEqual(result.files[0]!.fingerprint.length, 64);
    ok(/^[0-9a-f]{64}$/.test(result.files[0]!.fingerprint));
  });
});

/* ------------------------------------------------------------------ */
/*  Metadata guarantees                                                 */
/* ------------------------------------------------------------------ */

void describe("scanRepository — metadata-only guarantees", () => {
  void it("never returns file content in result", () => {
    const root = tmpDir();
    write(root, "appsettings.json", "secretValue: super-secret-123\n");
    write(root, ".env", "DB_PASSWORD=hidden\n");
    write(root, "config.yaml", "password: hunter2\n");

    const result = scanRepository("repo-w", root);

    for (const file of result.files) {
      // Ensure no content field exists
      const keys = Object.keys(file) as (keyof ConfigFileMetadata)[];
      for (const k of keys) {
        if (typeof file[k] === "string") {
          ok(!(file[k] as string).includes("super-secret-123"), `No content leaked in ${file.repoRelativePath}`);
          ok(!(file[k] as string).includes("hunter2"), `No content leaked in ${file.repoRelativePath}`);
          ok(!(file[k] as string).includes("hidden"), `No content leaked in ${file.repoRelativePath}`);
        }
      }
    }
  });

  void it("returns all expected metadata fields", () => {
    const root = tmpDir();
    write(root, "config.yaml", "key: value\n");

    const result = scanRepository("repo-x", root);
    strictEqual(result.files.length, 1);

    const file = result.files[0]!;
    ok(typeof file.repoId === "string");
    ok(typeof file.workspaceRelativePath === "string");
    ok(typeof file.repoRelativePath === "string");
    ok(typeof file.kind === "string");
    ok(typeof file.size === "number");
    ok(typeof file.mtime === "string");
    ok(typeof file.fingerprint === "string");
    ok(typeof file.probableSecret === "boolean");
    ok(typeof file.deploymentRelevance === "number");
    ok(Array.isArray(file.likelyEnvironments));
  });
});

/* ------------------------------------------------------------------ */
/*  Deployment relevance and environments                             */
/* ------------------------------------------------------------------ */

void describe("scanRepository — deployment relevance", () => {
  void it("assigns high relevance to docker-compose files", () => {
    const root = tmpDir();
    write(root, "docker-compose.yaml", "services:\n");

    const result = scanRepository("repo-y", root);
    const dc = result.files.find((f) => f.kind === "docker-compose");
    ok(dc);
    ok(dc.deploymentRelevance > 0.7);
  });

  void it("detects environments from filenames", () => {
    const root = tmpDir();
    write(root, "values.production.yaml", "replicas: 5\n");
    write(root, "config.staging.yaml", "debug: false\n");
    write(root, ".env.development", "DEBUG=true\n");
    write(root, "config.yaml", "generic: true\n");

    const result = scanRepository("repo-z", root);

    const prod = result.files.find((f) => f.repoRelativePath === "values.production.yaml");
    ok(prod);
    ok(prod!.likelyEnvironments.includes("production"), "production env should be detected");

    const staging = result.files.find((f) => f.repoRelativePath === "config.staging.yaml");
    ok(staging);
    ok(staging!.likelyEnvironments.includes("staging"), "staging env should be detected");

    const dev = result.files.find((f) => f.repoRelativePath === ".env.development");
    ok(dev);
    ok(dev!.likelyEnvironments.includes("development"), "development env should be detected");

    const generic = result.files.find((f) => f.repoRelativePath === "config.yaml");
    ok(generic);
    strictEqual(generic!.likelyEnvironments.length, 0, "generic file should have no env labels");
  });
});

/* ------------------------------------------------------------------ */
/*  scanRepositories — multi-repo                                      */
/* ------------------------------------------------------------------ */

void describe("scanRepositories — multi-repo", () => {
  void it("scans multiple repositories and reports unknown IDs", () => {
    const rootA = tmpDir();
    const rootB = tmpDir();
    write(rootA, "config.yaml", "repo-a\n");
    write(rootB, "app.json", "repo-b\n");

    const resolve = (id: string): { rootPath: string } | null => {
      if (id === "repo-alpha") return { rootPath: rootA };
      if (id === "repo-beta") return { rootPath: rootB };
      if (id === "repo-gamma") return { rootPath: "/nonexistent" };
      return null;
    };

    const { results, unknownRepoIds } = scanRepositories(
      ["repo-alpha", "repo-beta", "repo-gamma", "repo-unknown"],
      resolve,
    );

    // repo-gamma resolves to a path (even if nonexistent) — it's not "unknown"
    strictEqual(results.length, 3);
    strictEqual(unknownRepoIds.length, 1);
    deepStrictEqual(unknownRepoIds, ["repo-unknown"]);
  });
});

/* ------------------------------------------------------------------ */
/*  Edge cases                                                         */
/* ------------------------------------------------------------------ */

void describe("scanRepository — edge cases", () => {
  void it("handles empty repository", () => {
    const root = tmpDir();
    const result = scanRepository("repo-empty", root);
    strictEqual(result.files.length, 0);
    strictEqual(result.truncated, false);
  });

  void it("handles non-existent repository path", () => {
    const result = scanRepository("repo-nonexistent", "/tmp/does-not-exist-12345");
    strictEqual(result.files.length, 0);
    strictEqual(result.truncated, false);
  });

  void it("includes workspace-relative path when workspaceFilePath is provided", () => {
    const wsFile = join(tmpDir(), "test.code-workspace");
    const repoRoot = tmpDir();
    write(repoRoot, "config.yaml", "key: value\n");

    const result = scanRepository("repo-ws", repoRoot, {
      workspaceFilePath: wsFile,
    });

    strictEqual(result.files.length, 1);
    ok(result.files[0]!.workspaceRelativePath.length > 0);
    notStrictEqual(result.files[0]!.workspaceRelativePath, result.files[0]!.repoRelativePath);
  });
});
