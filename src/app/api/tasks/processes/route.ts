import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { loadConfig } from "@/lib/tasks/config";
import { taskRegistry } from "@/lib/tasks/registry";
import { getRepo } from "@/lib/git/registry";
import { isSameOriginRequest } from "@/lib/git/request-security";
import { verifyActionToken } from "@/lib/git/action-token";
import { toSessionPublic } from "@/lib/tasks/types";

/* ── Helpers ────────────────────────────────────────────────────── */

function rejectIfNotAuthorized(req: NextRequest): NextResponse | null {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const token = req.headers.get("x-action-token") ?? "";
  if (!verifyActionToken(token)) {
    return NextResponse.json({ error: "Invalid action token" }, { status: 403 });
  }
  return null;
}

function makeKey(repoId: string, worktreePath: string, procName: string): string {
  return taskRegistry.getKey(repoId, worktreePath, procName);
}

/* ── Line-buffered output capture ──────────────────────────────── */

const LINE_BUFFERS = new Map<string, string>();

function flushLines(key: string, chunk: Buffer, stream: "stdout" | "stderr"): void {
  const prefix = stream === "stderr" ? "[stderr] " : "";
  let buffer = LINE_BUFFERS.get(key) ?? "";
  buffer += chunk.toString("utf-8");

  const lines = buffer.split("\n");
  // The last element is either a partial line or empty (trailing newline)
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed.length > 0) {
      taskRegistry.appendLog(key, `${prefix}${trimmed}`);
    }
  }

  if (buffer.length > 0) {
    LINE_BUFFERS.set(key, buffer);
  } else {
    LINE_BUFFERS.delete(key);
  }
}

function flushRemainingLines(key: string, stream: "stdout" | "stderr"): void {
  const buffer = LINE_BUFFERS.get(key);
  if (buffer && buffer.length > 0) {
    const prefix = stream === "stderr" ? "[stderr] " : "";
    taskRegistry.appendLog(key, `${prefix}${buffer.trimEnd()}`);
    LINE_BUFFERS.delete(key);
  }
}

/* ── Start a single process ─────────────────────────────────────── */

async function startProcess(
  repoId: string,
  repoRoot: string,
  worktreePath: string,
  procDef: { name: string; command: string; workdir?: string; env?: Record<string, string> },
): Promise<{ session: ReturnType<typeof toSessionPublic> | null; error?: string }> {
  if (taskRegistry.isRunning(repoId, worktreePath, procDef.name)) {
    return { session: null, error: "already running" };
  }

  const cwd = procDef.workdir ? `${worktreePath}/${procDef.workdir}` : worktreePath;

  try {
    const child = spawn("/bin/sh", ["-c", procDef.command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(procDef.env ?? {}),
        REPO_PATH: repoRoot,
        WORKTREE_PATH: worktreePath,
      },
    });

    const pid = child.pid ?? 0;
    if (pid <= 0) {
      child.kill();
      return { session: null, error: "Child process has no valid PID" };
    }

    const key = makeKey(repoId, worktreePath, procDef.name);
    const session = taskRegistry.register(repoId, worktreePath, procDef.name, pid, repoRoot, child);

    child.stdout?.on("data", (chunk: Buffer) => flushLines(key, chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => flushLines(key, chunk, "stderr"));

    child.on("exit", (code) => {
      flushRemainingLines(key, "stdout");
      flushRemainingLines(key, "stderr");
      taskRegistry.markStopped(key, code);
    });

    child.on("error", (err) => {
      taskRegistry.markError(key, err.message);
    });

    return { session: toSessionPublic(session) };
  } catch (err) {
    return {
      session: null,
      error: err instanceof Error ? err.message : "Failed to start process",
    };
  }
}

/* ── Stop a single process ──────────────────────────────────────── */

async function stopProcess(
  repoId: string,
  worktreePath: string,
  processName: string,
): Promise<{ stopped: boolean; pid?: number; error?: string }> {
  const session = taskRegistry.get(repoId, worktreePath, processName);
  if (!session || session.status !== "running") {
    return { stopped: false, error: "not running" };
  }

  const pid = session.pid;
  if (pid <= 0) {
    return { stopped: false, error: "invalid pid" };
  }

  try {
    process.kill(pid, "SIGTERM");
    const key = makeKey(repoId, worktreePath, processName);
    taskRegistry.appendLog(key, "[SIGTERM sent]");
    taskRegistry.scheduleForceKill(key, pid, 3000);
    return { stopped: true, pid };
  } catch (err) {
    return {
      stopped: false,
      error: err instanceof Error ? err.message : "Failed to stop process",
    };
  }
}

/* ── POST — Start process(es) ───────────────────────────────────── */

export async function POST(req: NextRequest) {
  const authError = rejectIfNotAuthorized(req);
  if (authError) return authError;

  const repoId = req.nextUrl.searchParams.get("repoId");
  if (!repoId) {
    return NextResponse.json({ error: "repoId is required" }, { status: 400 });
  }

  const repo = getRepo(repoId);
  if (!repo) {
    return NextResponse.json({ error: "Repo not found" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const worktreePath = typeof body.worktreePath === "string" ? body.worktreePath : null;
  const processName = typeof body.processName === "string" ? body.processName : null;
  const groupName = typeof body.groupName === "string" ? body.groupName : null;

  if (!worktreePath) {
    return NextResponse.json({ error: "worktreePath is required" }, { status: 400 });
  }

  const { config } = loadConfig(repo.rootPath);
  if (!config) {
    return NextResponse.json({ error: "No tasks config found" }, { status: 404 });
  }

  /* ── Group start ──────────────────────────────────────────── */
  if (groupName) {
    const group = config.groups?.find((g) => g.name === groupName);
    if (!group) {
      return NextResponse.json({ error: `Group "${groupName}" not defined` }, { status: 404 });
    }

    const results: Array<{ processName: string; session: ReturnType<typeof toSessionPublic> | null; error?: string }> = [];
    let hasFailure = false;

    for (const pname of group.processes) {
      const procDef = config.processes.find((p) => p.name === pname);
      if (!procDef) {
        results.push({ processName: pname, session: null, error: "not defined in config" });
        hasFailure = true;
        continue;
      }
      const result = await startProcess(repoId, repo.rootPath, worktreePath, procDef);
      results.push({ processName: pname, ...result });
      if (result.error) hasFailure = true;
    }

    return NextResponse.json(
      { results },
      { status: hasFailure ? 207 : 200 },
    );
  }

  /* ── Single process start ─────────────────────────────────── */
  if (!processName) {
    return NextResponse.json({ error: "processName or groupName is required" }, { status: 400 });
  }

  const procDef = config.processes.find((p) => p.name === processName);
  if (!procDef) {
    return NextResponse.json({ error: `Process "${processName}" not defined in config` }, { status: 404 });
  }

  const result = await startProcess(repoId, repo.rootPath, worktreePath, procDef);
  if (result.error === "already running") {
    return NextResponse.json({ error: "Process is already running" }, { status: 409 });
  }
  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({ session: result.session, pid: result.session?.pid });
}

/* ── DELETE — Stop process(es) ──────────────────────────────────── */

export async function DELETE(req: NextRequest) {
  const authError = rejectIfNotAuthorized(req);
  if (authError) return authError;

  const repoId = req.nextUrl.searchParams.get("repoId");
  if (!repoId) {
    return NextResponse.json({ error: "repoId is required" }, { status: 400 });
  }

  const repo = getRepo(repoId);
  if (!repo) {
    return NextResponse.json({ error: "Repo not found" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const worktreePath = typeof body.worktreePath === "string" ? body.worktreePath : null;
  const processName = typeof body.processName === "string" ? body.processName : null;
  const groupName = typeof body.groupName === "string" ? body.groupName : null;
  const all = body.all === true;

  if (!worktreePath) {
    return NextResponse.json({ error: "worktreePath is required" }, { status: 400 });
  }

  const results: Array<{ processName: string; stopped: boolean; pid?: number; error?: string }> = [];
  let hasFailure = false;

  /* ── Stop all ─────────────────────────────────────────────── */
  if (all) {
    const sessions = taskRegistry.listByWorktree(repoId, worktreePath);
    for (const s of sessions) {
      const result = await stopProcess(repoId, worktreePath, s.processName);
      results.push({ processName: s.processName, ...result });
      if (result.error) hasFailure = true;
    }
    return NextResponse.json(
      { results },
      { status: hasFailure ? 207 : 200 },
    );
  }

  /* ── Group stop ───────────────────────────────────────────── */
  const { config } = loadConfig(repo.rootPath);

  if (groupName && config) {
    const group = config.groups?.find((g) => g.name === groupName);
    if (!group) {
      return NextResponse.json({ error: `Group "${groupName}" not defined` }, { status: 404 });
    }

    for (const pname of group.processes) {
      const result = await stopProcess(repoId, worktreePath, pname);
      results.push({ processName: pname, ...result });
      if (result.error) hasFailure = true;
    }
    return NextResponse.json(
      { results },
      { status: hasFailure ? 207 : 200 },
    );
  }

  /* ── Single process stop ──────────────────────────────────── */
  if (!processName) {
    return NextResponse.json({ error: "processName, groupName, or all=true is required" }, { status: 400 });
  }

  const result = await stopProcess(repoId, worktreePath, processName);
  if (result.error === "not running") {
    return NextResponse.json({ error: "Process is not running" }, { status: 404 });
  }
  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({ stopped: true, pid: result.pid });
}
