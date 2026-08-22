import { NextRequest, NextResponse } from "next/server";
import { taskRegistry } from "@/lib/tasks/registry";

/**
 * GET /api/tasks/logs?repoId=xxx&worktreePath=...&processName=api&lines=200
 *
 * Returns buffered log lines for a running/stopped process.
 */
export async function GET(req: NextRequest) {
  const repoId = req.nextUrl.searchParams.get("repoId");
  const worktreePath = req.nextUrl.searchParams.get("worktreePath");
  const processName = req.nextUrl.searchParams.get("processName");
  const linesParam = req.nextUrl.searchParams.get("lines");

  if (!repoId || !worktreePath || !processName) {
    return NextResponse.json(
      { error: "repoId, worktreePath, and processName are required" },
      { status: 400 },
    );
  }

  const lines = linesParam ? Math.min(parseInt(linesParam, 10) || 200, 1000) : 200;
  const session = taskRegistry.get(repoId, worktreePath, processName);
  if (!session) {
    return NextResponse.json({ lines: [], truncated: false });
  }

  const result = taskRegistry.getLogs(repoId, worktreePath, processName, lines);
  return NextResponse.json({
    processName,
    worktreePath,
    ...result,
    running: session.status === "running",
  });
}
