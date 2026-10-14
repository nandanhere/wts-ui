/**
 * Phase 1 — Tasks domain types.
 *
 * Config format (.dash-tasks.yaml), process definitions, running sessions.
 */

/* ── Config file schema (serialized as YAML) ────────────────────────── */

export interface DashTasksConfig {
  processes: TaskProcessDef[];
  groups?: TaskGroupDef[];
}

export interface TaskProcessDef {
  name: string;
  command: string;
  description?: string;
  /** Working directory relative to repo root (default ".") */
  workdir?: string;
  /** Environment variables (optional) */
  env?: Record<string, string>;
}

export interface TaskGroupDef {
  name: string;
  processes: string[];
}

/* ── Running session ───────────────────────────────────────────────── */

/** Full session (internal — includes logBuffer). Use TaskSessionPublic for API responses. */
export interface TaskSession {
  id: string;
  repoId: string;
  repoPath: string;
  worktreePath: string;
  processName: string;
  pid: number;
  startedAt: number;
  status: "running" | "stopped" | "exited" | "error";
  exitCode: number | null;
  /** Captured stdout/stderr lines (capped at MAX_LOG_LINES — internal only) */
  logBuffer: string[];
}

/** Public session summary returned in status/processes API responses (no logBuffer). */
export interface TaskSessionPublic {
  id: string;
  repoId: string;
  repoPath: string;
  worktreePath: string;
  processName: string;
  pid: number;
  startedAt: number;
  status: "running" | "stopped" | "exited" | "error";
  exitCode: number | null;
}

/** Convert a full session to its public (API-safe) form without logBuffer. */
export function toSessionPublic(session: TaskSession): TaskSessionPublic {
  const { logBuffer: _, ...rest } = session;
  return rest;
}

/* ── Composite status for the UI ───────────────────────────────────── */

export interface TaskProcessStatus {
  name: string;
  command: string;
  description?: string;
  running: boolean;
  session: TaskSessionPublic | null;
}

export interface TaskWorktreeStatus {
  path: string;
  branch: string | null;
  isPrimary: boolean;
  configState: "missing" | "valid" | "invalid";
  configError?: string;
  processes: TaskProcessStatus[];
}

export interface TaskRepoStatus {
  repoId: string;
  repoName: string;
  repoPath: string;
  config: DashTasksConfig | null;
  configState: "missing" | "valid" | "invalid";
  configError?: string;
  worktrees: TaskWorktreeStatus[];
}

export interface TasksSummary {
  reposConfigured: number;
  processesRunning: number;
  repos: TaskRepoStatus[];
}
