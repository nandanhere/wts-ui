/**
 * In-memory registry for running task process sessions.
 *
 * Uses a `globalThis` key in development so Next.js hot-reload does not
 * lose track of running child processes when the module is re-evaluated.
 */
import { randomUUID } from "crypto";
import type { TaskSession } from "./types";

const MAX_LOG_LINES = 1000;
const SHUTDOWN_TIMEOUT_MS = 3000;

type SessionKey = string; // `${repoId}:${worktreePath}:${processName}`

const GLOBAL_KEY = "__dashTaskRegistry";

function makeKey(repoId: string, worktreePath: string, processName: string): SessionKey {
  return `${repoId}::${worktreePath}::${processName}`;
}

class TaskRegistry {
  private sessions = new Map<SessionKey, TaskSession>();
  private children = new Map<SessionKey, import("child_process").ChildProcess>();
  private shutdownTimers = new Map<SessionKey, ReturnType<typeof setTimeout>>();
  private shutdownStarted = false;

  /* ── Registration ──────────────────────────────────────────── */

  register(
    repoId: string,
    worktreePath: string,
    processName: string,
    pid: number,
    repoPath: string,
    childProc?: import("child_process").ChildProcess,
  ): TaskSession {
    const key = makeKey(repoId, worktreePath, processName);
    const existing = this.sessions.get(key);
    if (existing && existing.status === "running") {
      return existing;
    }

    const session: TaskSession = {
      id: randomUUID(),
      repoId,
      repoPath,
      worktreePath,
      processName,
      pid,
      startedAt: Date.now(),
      status: "running",
      exitCode: null,
      logBuffer: [],
    };
    this.sessions.set(key, session);
    if (childProc) {
      this.children.set(key, childProc);
    }
    return session;
  }

  /* ── Log buffering ─────────────────────────────────────────── */

  appendLog(key: SessionKey, line: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    session.logBuffer.push(line);
    if (session.logBuffer.length > MAX_LOG_LINES) {
      session.logBuffer.splice(0, session.logBuffer.length - MAX_LOG_LINES);
    }
  }

  getLogs(
    repoId: string,
    worktreePath: string,
    processName: string,
    lines?: number,
  ): { lines: string[]; truncated: boolean } {
    const session = this.get(repoId, worktreePath, processName);
    if (!session || session.logBuffer.length === 0) {
      return { lines: [], truncated: false };
    }
    const count = Math.max(1, Math.min(lines ?? session.logBuffer.length, MAX_LOG_LINES));
    const sliced = session.logBuffer.slice(-count);
    return {
      lines: sliced,
      truncated: session.logBuffer.length > count,
    };
  }

  /* ── State transitions ─────────────────────────────────────── */

  markStopped(key: SessionKey, exitCode: number | null): void {
    const session = this.sessions.get(key);
    if (!session) return;
    session.status = exitCode === 0 ? "stopped" : "exited";
    session.exitCode = exitCode;
    this.cancelShutdownTimer(key);
    this.children.delete(key);
  }

  markError(key: SessionKey, error: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    session.status = "error";
    session.exitCode = -1;
    this.appendLog(key, `[error: ${error}]`);
    this.cancelShutdownTimer(key);
    this.children.delete(key);
  }

  /* ── Query ─────────────────────────────────────────────────── */

  get(repoId: string, worktreePath: string, processName: string): TaskSession | undefined {
    return this.sessions.get(makeKey(repoId, worktreePath, processName));
  }

  isRunning(repoId: string, worktreePath: string, processName: string): boolean {
    const session = this.get(repoId, worktreePath, processName);
    return session?.status === "running";
  }

  listByWorktree(repoId: string, worktreePath: string): TaskSession[] {
    const results: TaskSession[] = [];
    for (const [key, session] of this.sessions) {
      if (key.startsWith(`${repoId}::${worktreePath}::`)) {
        results.push(session);
      }
    }
    return results;
  }

  remove(repoId: string, worktreePath: string, processName: string): void {
    const key = makeKey(repoId, worktreePath, processName);
    this.sessions.delete(key);
    this.children.delete(key);
    this.cancelShutdownTimer(key);
  }

  getAll(): TaskSession[] {
    return Array.from(this.sessions.values());
  }

  getKey(repoId: string, worktreePath: string, processName: string): SessionKey {
    return makeKey(repoId, worktreePath, processName);
  }

  /* ── SIGKILL escalation ────────────────────────────────────── */

  scheduleForceKill(key: SessionKey, pid: number, delayMs: number): void {
    this.cancelShutdownTimer(key);
    const timer = setTimeout(() => {
      try {
        process.kill(pid, "SIGKILL");
        this.appendLog(key, "[SIGKILL sent after timeout]");
      } catch {
        // already dead
      }
      this.shutdownTimers.delete(key);
    }, delayMs);
    // Allow the timer to not prevent process exit
    if (timer.unref) timer.unref();
    this.shutdownTimers.set(key, timer);
  }

  private cancelShutdownTimer(key: SessionKey): void {
    const timer = this.shutdownTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.shutdownTimers.delete(key);
    }
  }

  /* ── Shutdown ──────────────────────────────────────────────── */

  async shutdown(): Promise<void> {
    if (this.shutdownStarted) return;
    this.shutdownStarted = true;

    const running = Array.from(this.sessions.entries()).filter(
      ([, s]) => s.status === "running",
    );

    for (const [key, session] of running) {
      try {
        const child = this.children.get(key);
        if (child && !child.killed) {
          child.kill("SIGTERM");
        } else if (session.pid > 0) {
          process.kill(session.pid, "SIGTERM");
        }
        this.appendLog(key, "[SIGTERM sent — server shutdown]");
        // Schedule SIGKILL fallback
        if (session.pid > 0) {
          this.scheduleForceKill(key, session.pid, 2000);
        }
      } catch {
        // already dead
      }
    }

    if (running.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS));
    }
  }

  /** Reset shutdown flag (for testing). */
  resetShutdown(): void {
    this.shutdownStarted = false;
  }
}

/* ── Singleton — survive hot-reload ────────────────────────────── */

function getRegistry(): TaskRegistry {
  if (typeof globalThis !== "undefined") {
    const existing = (globalThis as any)[GLOBAL_KEY];
    if (existing) return existing;
    const instance = new TaskRegistry();
    (globalThis as any)[GLOBAL_KEY] = instance;
    return instance;
  }
  return new TaskRegistry();
}

export const taskRegistry = getRegistry();

/* ── Signal handlers (installed once) ─────────────────────────── */

const HANDLER_INSTALLED = "__dashTaskShutdownInstalled";

function installShutdownHandlers(): void {
  if ((globalThis as any)[HANDLER_INSTALLED]) return;
  (globalThis as any)[HANDLER_INSTALLED] = true;

  const shutdown = async () => {
    await taskRegistry.shutdown();
    process.exit(128 + 15); // SIGTERM conventional exit code
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

installShutdownHandlers();
