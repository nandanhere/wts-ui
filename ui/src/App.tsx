import { lazy, Suspense, useEffect } from "react";
import type { WorkspaceClient } from "./lib/wtsClient";
import { ThemeProvider } from "./theme";
import { UiCallouts } from "./components/UiCallouts";

const LocalWorkspace = lazy(() =>
  import("./variants/local-workspace").then((module) => ({
    default: module.LocalWorkspace,
  })),
);

const boardAliases = new Set([
  "/wts-lab",
  "/portfolio-board",
  "/variants/portfolio-board",
  "/wts-lab/portfolio-board",
  "/session-workbench",
  "/variants/session-workbench",
  "/wts-lab/session-workbench",
]);

function AppLoader() {
  return (
    <div
      data-ui="app.loading"
      data-ui-label="Loading screen"
      role="status"
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--wts-canvas)",
        color: "var(--wts-muted)",
        font: "12px ui-monospace, monospace",
        letterSpacing: ".06em",
      }}
    >
      Loading local workspaces…
    </div>
  );
}

function MissingRoute() {
  return (
    <main
      data-ui="app.missing-route"
      data-ui-label="Missing page"
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--wts-canvas)",
        color: "var(--wts-ink)",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
      }}
    >
      <div>
        <p>That local WTS route does not exist.</p>
        <a href="/">Return to my workspaces</a>
      </div>
    </main>
  );
}

function LegacyBoardRoute({
  client,
}: {
  client?: WorkspaceClient;
}) {
  useEffect(() => {
    globalThis.history?.replaceState(null, "", "/");
  }, []);
  return <LocalWorkspace client={client} />;
}

function WorkspaceRoute({
  client,
  legacyPath,
  tab,
  workspaceId,
}: {
  client?: WorkspaceClient;
  legacyPath: boolean;
  tab: "overview" | "planning" | "changes" | "verification";
  workspaceId: string;
}) {
  const canonicalPath = `/sessions/${encodeURIComponent(workspaceId)}`;

  useEffect(() => {
    if (legacyPath) {
      globalThis.history?.replaceState(null, "", canonicalPath);
    }
  }, [canonicalPath, legacyPath]);

  return (
    <LocalWorkspace
      initialView="workbench"
      initialWorkspaceId={workspaceId}
      initialWorkbenchTab={tab}
      client={client}
    />
  );
}

function routePath(explicitPath?: string) {
  const pathname = explicitPath ?? globalThis.location?.pathname ?? "/";
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

export function App({
  workspaceClient,
  initialPath,
}: {
  workspaceClient?: WorkspaceClient;
  initialPath?: string;
} = {}) {
  const path = routePath(initialPath);
  let content;

  if (path === "/" || path === "/sessions") {
    content = <LocalWorkspace client={workspaceClient} />;
  } else if (path === "/time") {
    content = <LocalWorkspace initialView="time" client={workspaceClient} />;
  } else if (path === "/reviews") {
    content = <LocalWorkspace initialView="reviews" client={workspaceClient} />;
  } else if (path === "/updates") {
    content = <LocalWorkspace initialView="updates" client={workspaceClient} />;
  } else if (path === "/sessions/new") {
    content = (
      <LocalWorkspace initialCreateOpen client={workspaceClient} />
    );
  } else if (
    path.match(
      /^\/sessions\/[^/]+(?:\/(?:overview|planning|changes|verification|agent|cli))?$/,
    )
  ) {
    const [, workspaceId, tab] =
      path.match(
        /^\/sessions\/([^/]+)(?:\/(overview|planning|changes|verification|agent|cli))?$/,
      ) ?? [];
    content = (
      <WorkspaceRoute
        workspaceId={decodeURIComponent(workspaceId)}
        tab={
          tab === "planning"
            ? "planning"
            : tab === "changes"
            ? "changes"
            : tab === "verification"
              ? "verification"
              : "overview"
        }
        legacyPath={tab === "overview" || tab === "agent" || tab === "cli"}
        client={workspaceClient}
      />
    );
  } else if (boardAliases.has(path)) {
    content = <LegacyBoardRoute client={workspaceClient} />;
  } else {
    content = <MissingRoute />;
  }

  return (
    <ThemeProvider>
      <Suspense fallback={<AppLoader />}>{content}</Suspense>
      <UiCallouts />
    </ThemeProvider>
  );
}
