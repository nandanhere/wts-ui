import { NextRequest, NextResponse } from "next/server";
import { loadConfig } from "@/lib/tasks/config";
import { taskRegistry } from "@/lib/tasks/registry";
import { getRepo } from "@/lib/git/registry";
import { toSessionPublic } from "@/lib/tasks/types";
import type { TaskRepoStatus, TaskWorktreeStatus } from "@/lib/tasks/types";

export async function GET(req: NextRequest) {
  const repoId = req.nextUrl.searchParams.get("repoId");
  if (!repoId) {
    return NextResponse.json({ error: "repoId is required" }, { status: 400 });
  }

  const repo = getRepo(repoId);
  if (!repo) {
    return NextResponse.json({ error: "Repo not found" }, { status: 404 });
  }

  const { config, error: configError } = loadConfig(repo.rootPath);
  const configState = config ? "valid" : (configError ? "invalid" : "missing");

  // Build worktree list
  const worktrees: TaskWorktreeStatus[] = [];

  // Primary worktree
  const primary: TaskWorktreeStatus = {
    path: repo.rootPath,
    branch: repo.worktree?.branch ?? null,
    isPrimary: true,
    configState,
    configError: configError ?? undefined,
    processes: [],
  };

  if (config) {
    primary.processes = config.processes.map((p) => {
      const session = taskRegistry.get(repoId, repo.rootPath, p.name);
      return {
        name: p.name,
        command: p.command,
        description: p.description,
        running: session?.status === "running",
        session: session ? toSessionPublic(session) : null,
      };
    });
  }
  worktrees.push(primary);

  const result: TaskRepoStatus = {
    repoId,
    repoName: repoId,
    repoPath: repo.rootPath,
    config,
    configState,
    configError: configError ?? undefined,
    worktrees,
  };

  return NextResponse.json(result);
}
