import { NextRequest, NextResponse } from "next/server";
import { loadConfig } from "@/lib/tasks/config";
import { getRepo } from "@/lib/git/registry";

export async function GET(req: NextRequest) {
  const repoId = req.nextUrl.searchParams.get("repoId");
  if (!repoId) {
    return NextResponse.json({ error: "repoId is required" }, { status: 400 });
  }

  const repo = getRepo(repoId);
  if (!repo) {
    return NextResponse.json({ error: "Repo not found" }, { status: 404 });
  }

  const { config, path } = loadConfig(repo.rootPath);
  return NextResponse.json({ config, path, repoPath: repo.rootPath });
}
