import { Suspense } from "react";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-ink">
          <div className="text-center">
            <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-sm text-muted">Loading dashboard...</p>
          </div>
        </div>
      }
    >
      <WorkspaceShell />
    </Suspense>
  );
}
