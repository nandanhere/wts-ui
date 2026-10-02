/**
 * Bounded, read-only configuration file scanner.
 *
 * Walks a repository directory tree (respecting limits and exclusions),
 * classifies files by kind, fingerprints them (SHA-256), and assesses
 * deployment relevance — all WITHOUT returning file content.
 *
 * Shell-free: uses only `fs` (readdirSync, lstatSync, openSync/readSync).
 */

import {
  readdirSync,
  lstatSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join, relative, dirname } from "node:path";
import { createHash } from "node:crypto";
import type {
  ConfigFileMetadata,
  ConfigInventoryResult,
  ConfigKind,
  ScannerOptions,
  ScanLimits,
} from "./types";
import { DEFAULT_SCAN_LIMITS } from "./types";

/* ------------------------------------------------------------------ */
/*  Exclusion patterns — dirs to prune entirely                       */
/* ------------------------------------------------------------------ */

const EXCLUDED_DIRS: RegExp[] = [
  /^node_modules$/,
  /^\.git$/,
  /^\.gocache$/,
  /^vendor$/,
  /^\.next$/,
  /^out$/,
  /^build$/,
  /^dist$/,
  /^target$/,
  /^__pycache__$/,
  /^\.venv$/,
  /^venv$/,
  /^env$/,
  /^\.pytest_cache$/,
  /^\.bzr$/,
  /^\.hg$/,
  /^\.svn$/,
  /^\.gitlab$/,
  /^node_modules\.old$/,
  /^\.terraform$/,
  /^\.terragrunt$/,
  /^\.serverless$/,
  /^cdk\.out$/,
  /^Pods$/,
  /^\.build$/,
  /^\.swiftpm$/,
  /^gradle$/,
  /^\.gradle$/,
  /^\.idea$/,
  /^\.vscode$/,
  /^bin$/,
  /^obj$/,
  /^packages$/,
  /^test$/,
  /^tests$/,
  /^spec$/,
  /^__tests__$/,
  /^coverage$/,
  /^\.cache$/,
  /^graphify-out$/,
  /^\.claude$/,
  /^\.opencode$/,
  /^\.agents$/,
];

/* ------------------------------------------------------------------ */
/*  Config-relevant file patterns                                      */
/* ------------------------------------------------------------------ */

/**
 * Patterns for "useful config files" — deployment, CI, environment, and
 * application configuration. Conservative: we err on the side of discovery
 * and the metadata-only nature means no risk of content exposure.
 */
interface FilePattern {
  /** Regexp source to test against the file's basename */
  nameRe: RegExp;
  /** Classified kind */
  kind: ConfigKind;
  /** Base deployment relevance score (0.0–1.0) */
  relevance: number;
  /** Whether the name pattern suggests secrets may be present */
  secretSuspicion: boolean;
}

const FILE_PATTERNS: FilePattern[] = [
  /* ── Helm / Kubernetes (most specific first) ────────────── */
  { nameRe: /^Chart\.ya?ml$/i, kind: "helm-chart", relevance: 0.9, secretSuspicion: false },
  { nameRe: /^values(?:\.\w+)?\.ya?ml$/i, kind: "helm-chart", relevance: 0.8, secretSuspicion: false },
  { nameRe: /^secrets(?:\.\w+)?\.ya?ml$/i, kind: "helm-chart", relevance: 0.7, secretSuspicion: true },
  { nameRe: /^kustomization\.ya?ml$/i, kind: "kubernetes", relevance: 0.8, secretSuspicion: false },
  { nameRe: /^kustomize\.yaml$/i, kind: "kubernetes", relevance: 0.8, secretSuspicion: false },
  { nameRe: /\.k8s\.ya?ml$/i, kind: "kubernetes", relevance: 0.7, secretSuspicion: false },

  /* ── Docker Compose ──────────────────────────────────────── */
  { nameRe: /^docker-compose(?:\.\w+)?\.ya?ml$/i, kind: "docker-compose", relevance: 0.9, secretSuspicion: false },
  { nameRe: /^compose(?:\.\w+)?\.ya?ml$/i, kind: "docker-compose", relevance: 0.8, secretSuspicion: false },

  /* ── Docker ──────────────────────────────────────────────── */
  { nameRe: /^Dockerfile(?:\.\w+)?$/i, kind: "other", relevance: 0.8, secretSuspicion: false },

  /* ── GitLab CI ────────────────────────────────────────────── */
  { nameRe: /^\.gitlab-ci\.ya?ml$/i, kind: "gitlab-ci", relevance: 0.8, secretSuspicion: false },

  /* ── Environment / env files ─────────────────────────────── */
  { nameRe: /^\.env\.example$/i, kind: "env-example", relevance: 0.6, secretSuspicion: false },
  { nameRe: /^env\.example$/i, kind: "env-example", relevance: 0.6, secretSuspicion: false },
  { nameRe: /\.env\.example$/i, kind: "env-example", relevance: 0.6, secretSuspicion: false },
  { nameRe: /^\.env\.\w+$/i, kind: "dotenv", relevance: 0.5, secretSuspicion: true },
  { nameRe: /^\.env$/i, kind: "dotenv", relevance: 0.5, secretSuspicion: true },

  /* ── Terraform ─────────────────────────────────────────── */
  { nameRe: /^terraform\.tfstate(?:\.backup)?$/i, kind: "other", relevance: 0.4, secretSuspicion: false },
  { nameRe: /\.tfvars$/i, kind: "other", relevance: 0.6, secretSuspicion: true },
  { nameRe: /\.tf$/i, kind: "other", relevance: 0.7, secretSuspicion: false },

  /* ── Ansible ───────────────────────────────────────────── */
  { nameRe: /^(?:site|playbook|requirements|ansible)\.ya?ml$/i, kind: "yaml", relevance: 0.7, secretSuspicion: false },
  { nameRe: /inventory(?:_\w+)?(?:\.ya?ml|\.ini|\.cfg)?$/i, kind: "other", relevance: 0.6, secretSuspicion: false },

  /* ── Nix / Flakes ─────────────────────────────────────── */
  { nameRe: /^flake\.nix$/i, kind: "other", relevance: 0.6, secretSuspicion: false },
  { nameRe: /\.nix$/i, kind: "other", relevance: 0.4, secretSuspicion: false },

  /* ── INI / cfg / conf ──────────────────────────────────── */
  { nameRe: /\.(?:ini|cfg|conf|cnf)$/i, kind: "ini", relevance: 0.4, secretSuspicion: false },

  /* ── Makefiles ───────────────────────────────────────────── */
  { nameRe: /^(?:GNU)?[Mm]akefile(?:\..+)?$/i, kind: "other", relevance: 0.5, secretSuspicion: false },

  /* ── Procfile / .pkg / .tool-versions ─────────────────── */
  { nameRe: /^Procfile$/i, kind: "other", relevance: 0.5, secretSuspicion: false },
  { nameRe: /^\.tool-versions$/i, kind: "other", relevance: 0.4, secretSuspicion: false },

  /* ── Generic config (YAML/JSON/TOML) — last, catch-all ─ */
  { nameRe: /\.ya?ml$/i, kind: "yaml", relevance: 0.5, secretSuspicion: false },
  { nameRe: /\.json$/i, kind: "json", relevance: 0.4, secretSuspicion: false },
  { nameRe: /\.toml$/i, kind: "toml", relevance: 0.5, secretSuspicion: false },

  /* ── Linting / editor config ──────────────────────────── */
  { nameRe: /\.editorconfig$/i, kind: "other", relevance: 0.2, secretSuspicion: false },
  { nameRe: /^\.(?:flake8|prettierrc|eslintrc|stylelintrc)/i, kind: "other", relevance: 0.3, secretSuspicion: false },

  /* ── Certificates / keys ──────────────────────────────── */
  { nameRe: /\.(?:pem|crt|key|cer|p12|pfx)$/i, kind: "other", relevance: 0.3, secretSuspicion: true },
  { nameRe: /\.vault$/i, kind: "other", relevance: 0.5, secretSuspicion: true },
];

/* ------------------------------------------------------------------ */
/*  Secret-name patterns                                               */
/* ------------------------------------------------------------------ */

const SECRET_NAME_PATTERNS: RegExp[] = [
  /secret/i,
  /password/i,
  /passwd/i,
  /credential/i,
  /token/i,
  /api[_-]?key/i,
  /auth/i,
  /private[_-]?key/i,
  /certificate/i,
  /pem/i,
  /pkcs/i,
  /jwt/i,
  /\.vault$/i,
  /\.age$/i,
  /\.sops\./i,
];

/* ------------------------------------------------------------------ */
/*  Environment heuristics                                             */
/* ------------------------------------------------------------------ */

const ENV_PATTERNS: [RegExp, string][] = [
  [/production/i, "production"],
  [/staging/i, "staging"],
  [/development/i, "development"],
  [/dev/i, "development"],
  [/test/i, "test"],
  [/qa/i, "qa"],
  [/integration/i, "integration"],
  [/uat/i, "uat"],
  [/prod/i, "production"],
  [/live/i, "production"],
  [/canary/i, "canary"],
  [/demo/i, "demo"],
  [/sandbox/i, "sandbox"],
  [/dr\b/i, "disaster-recovery"],
  [/backup/i, "backup"],
];

/* ------------------------------------------------------------------ */
/*  Merged exclusions                                                 */
/* ------------------------------------------------------------------ */

function buildExcludedDirs(extraPatterns: string[]): RegExp[] {
  const patterns = [...EXCLUDED_DIRS];
  for (const src of extraPatterns) {
    try {
      patterns.push(new RegExp(src));
    } catch {
      // skip invalid patterns
    }
  }
  return patterns;
}

/* ------------------------------------------------------------------ */
/*  File classification                                               */
/* ------------------------------------------------------------------ */

function classifyFile(
  name: string,
  repoRelativePath: string,
): { kind: ConfigKind; relevance: number; secretSuspicion: boolean } | null {
  for (const pat of FILE_PATTERNS) {
    if (pat.nameRe.test(name) || pat.nameRe.test(repoRelativePath)) {
      return {
        kind: pat.kind,
        relevance: pat.relevance,
        secretSuspicion: pat.secretSuspicion,
      };
    }
  }
  return null;
}

function checkProbableSecret(name: string, repoRelativePath: string): boolean {
  for (const re of SECRET_NAME_PATTERNS) {
    if (re.test(name) || re.test(repoRelativePath)) return true;
  }
  return false;
}

function classifyEnvironments(name: string, repoRelativePath: string): string[] {
  const envs: string[] = [];
  for (const [re, label] of ENV_PATTERNS) {
    if (re.test(name) || re.test(repoRelativePath)) {
      if (!envs.includes(label)) envs.push(label);
    }
  }
  return envs;
}

/* ------------------------------------------------------------------ */
/*  File fingerprinting (content hash, no value exposure)             */
/* ------------------------------------------------------------------ */

/**
 * Read up to `maxBytes` from a file and return its SHA-256 hex digest.
 * Returns empty string on error (permission, binary, etc.).
 */
function fingerprintFile(absPath: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(absPath, "r");
    const buf = Buffer.alloc(Math.min(maxBytes, 65536)); // 64 KB chunks
    const hash = createHash("sha256");
    let totalRead = 0;

    while (totalRead < maxBytes) {
      const remaining = maxBytes - totalRead;
      const toRead = Math.min(remaining, buf.length);
      const bytesRead = readSync(fd, buf, 0, toRead, totalRead);
      if (bytesRead <= 0) break;
      hash.update(buf.subarray(0, bytesRead));
      totalRead += bytesRead;
    }

    return hash.digest("hex");
  } catch {
    // Permission errors, binary files, etc.
    return "";
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed or unavailable */ }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Directory walking                                                  */
/* ------------------------------------------------------------------ */

interface WalkOptions {
  excludedDirs: RegExp[];
  maxDepth: number;
  maxFiles: number;
  maxFileBytes: number;
  totalBytes: number;
  workspaceFilePath?: string;
}

interface WalkResult {
  files: ConfigFileMetadata[];
  truncated: boolean;
  errors: string[];
  currentBytes: number;
  fileCount: number;
}

function walkDir(
  dirPath: string,
  repoRoot: string,
  repoId: string,
  depth: number,
  opts: WalkOptions,
  state: WalkResult,
): void {
  if (depth > opts.maxDepth) return;
  if (state.truncated) return;

  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return;
  }

  for (const name of entries) {
    if (state.fileCount >= opts.maxFiles) {
      state.truncated = true;
      return;
    }

    const absPath = join(dirPath, name);
    let stat: import("node:fs").Stats;
    try {
      stat = lstatSync(absPath);
    } catch {
      continue;
    }

    // Never follow links. A repository-controlled symlink must not allow this
    // metadata scanner to traverse or fingerprint files outside the repo root.
    if (stat.isSymbolicLink()) continue;

    // Skip excluded directories entirely
    if (stat.isDirectory()) {
      if (opts.excludedDirs.some((re) => re.test(name))) continue;
      walkDir(absPath, repoRoot, repoId, depth + 1, opts, state);
      continue;
    }

    // Only process regular files
    if (!stat.isFile()) continue;

    const repoRelativePath = relative(repoRoot, absPath);
    const workspaceRelativePath = opts.workspaceFilePath
      ? relative(dirname(opts.workspaceFilePath), absPath)
      : repoRelativePath;

    // Classify
    const classification = classifyFile(name, repoRelativePath);
    if (!classification) continue;

    const size = stat.size;
    const mtime = stat.mtime.toISOString();

    const probableSecret = classification.secretSuspicion || checkProbableSecret(name, repoRelativePath);

    // Never fingerprint files whose names indicate secret material. Hashes can
    // still disclose equality against known values, so metadata is sufficient.
    const readBytes = Math.min(size, opts.maxFileBytes);
    const budgetCharge = Math.max(readBytes, 4096);
    if (state.currentBytes + budgetCharge > opts.totalBytes) {
      state.truncated = true;
      return;
    }
    const fingerprint = probableSecret ? "" : fingerprintFile(absPath, readBytes);

    // Update byte budget even if fingerprint is empty
    state.currentBytes += budgetCharge; // at least 4 KB per file touched

    const likelyEnvironments = classifyEnvironments(name, repoRelativePath);

    state.files.push({
      repoId,
      workspaceRelativePath,
      repoRelativePath,
      kind: classification.kind,
      size,
      mtime,
      fingerprint,
      probableSecret,
      deploymentRelevance: classification.relevance,
      likelyEnvironments,
    });

    state.fileCount++;
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Scan a single repository for configuration files.
 *
 * @param repoId       - Stable repository ID
 * @param repoRootPath - Absolute path to the repository root
 * @param options      - Scanner options (limits, exclusions, etc.)
 * @returns A ConfigInventoryResult with metadata only, never content.
 */
export function scanRepository(
  repoId: string,
  repoRootPath: string,
  options: ScannerOptions = {},
): ConfigInventoryResult {
  const startTime = Date.now();

  const requested = { ...DEFAULT_SCAN_LIMITS, ...options.limits };
  const limits: ScanLimits = {
    maxDepth: Math.min(12, Math.max(0, Math.floor(requested.maxDepth))),
    maxFiles: Math.min(500, Math.max(1, Math.floor(requested.maxFiles))),
    maxFileBytes: Math.min(1024 * 1024, Math.max(1024, Math.floor(requested.maxFileBytes))),
    totalBytes: Math.min(50 * 1024 * 1024, Math.max(4096, Math.floor(requested.totalBytes))),
  };

  const excludedDirs = buildExcludedDirs(options.excludeDirPatterns ?? []);

  const walkOpts: WalkOptions = {
    excludedDirs,
    maxDepth: limits.maxDepth,
    maxFiles: limits.maxFiles,
    maxFileBytes: limits.maxFileBytes,
    totalBytes: limits.totalBytes,
    workspaceFilePath: options.workspaceFilePath,
  };

  const state: WalkResult = {
    files: [],
    truncated: false,
    errors: [],
    currentBytes: 0,
    fileCount: 0,
  };

  walkDir(
    repoRootPath,
    repoRootPath,
    repoId,
    0,
    walkOpts,
    state,
  );

  return {
    repoId,
    repoRootPath,
    files: state.files,
    truncated: state.truncated,
    scanTimeMs: Date.now() - startTime,
    errors: state.errors,
    limits,
  };
}

/* ------------------------------------------------------------------ */
/*  Multi-repo scan                                                   */
/* ------------------------------------------------------------------ */

/**
 * Scan multiple repositories. Unknown repo IDs are returned separately.
 *
 * @param repoIds  - Array of registered repo IDs
 * @param resolve  - Function to resolve a repo ID to its root path (or null)
 * @param options  - Scanner options
 * @returns A result list and any unknown IDs.
 */
export function scanRepositories(
  repoIds: string[],
  resolve: (id: string) => { rootPath: string; workspaceFilePath?: string } | null,
  options: ScannerOptions = {},
): { results: ConfigInventoryResult[]; unknownRepoIds: string[] } {
  const results: ConfigInventoryResult[] = [];
  const unknownRepoIds: string[] = [];

  for (const repoId of repoIds) {
    const resolved = resolve(repoId);
    if (!resolved) {
      unknownRepoIds.push(repoId);
      continue;
    }

    const result = scanRepository(repoId, resolved.rootPath, {
      ...options,
      workspaceFilePath: options.workspaceFilePath ?? resolved.workspaceFilePath,
    });
    results.push(result);
  }

  return { results, unknownRepoIds };
}
