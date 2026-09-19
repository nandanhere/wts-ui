import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  IntegrationId,
  IntegrationSnapshot,
  JiraMcpVerification,
  OpenProjectVerification,
  RepositoryCatalog,
  SetupSnapshot,
  WorkspaceClient,
} from "../../lib/wtsClient";
import {
  type ThemePreference,
  useTheme,
} from "../../theme";
import {
  type WorkspaceCardClickPreference,
  useWorkspaceCardClickPreference,
} from "./workspaceCardPreference";
import styles from "./SetupSheet.module.css";
import { useDialogFocusReturn } from "../../components/useDialogFocusReturn";
import { GitlabIntegrationCard } from "./GitlabIntegrationCard";
import {
  AppUpdateScreen,
  type AppUpdateController,
} from "./AppUpdateScreen";

export type { RepositoryCatalog, SetupSnapshot } from "../../lib/wtsClient";

type SetupIntegrationId = IntegrationId;
type SetupIntegration = IntegrationSnapshot;
type SetupBlockingCapability = IntegrationSnapshot["blockingFor"][number];
type SetupCapability = IntegrationSnapshot["capabilities"][number];
type BrowserJourneyReadiness = NonNullable<
  SetupSnapshot["browserJourneyReadiness"]
>;
type BrowserJourneyReadinessCheck =
  BrowserJourneyReadiness["node"];

export interface SetupSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot?: SetupSnapshot;
  repositories?: RepositoryCatalog;
  loading: boolean;
  error?: string;
  onRefresh: () => void;
  onVerifyJira?: () => Promise<JiraMcpVerification>;
  onVerifyOpenProject?: () => Promise<OpenProjectVerification>;
  client?: WorkspaceClient;
  gitlabWorkspaceId?: string;
  appUpdate?: AppUpdateController;
}

type PreferenceSection = "general" | "repositories" | "integrations" | "updates";
type VerificationTone =
  | "verified"
  | "auth"
  | "setup"
  | "unavailable"
  | "failed"
  | "checking"
  | "unchecked";

interface IntegrationDefinition {
  id: SetupIntegrationId;
  label: string;
  mark: string;
  description: string;
  capability: string;
}

const integrationDefinitions: Record<
  SetupIntegrationId,
  IntegrationDefinition
> = {
  git: {
    id: "git",
    label: "Git",
    mark: "GT",
    description: "Local version control engine",
    capability: "Inspect repositories and create isolated worktrees",
  },
  jiraMcp: {
    id: "jiraMcp",
    label: "Jira via MCP",
    mark: "JR",
    description: "Issue context provider",
    capability: "Import issue details and repository evidence",
  },
  openProject: {
    id: "openProject",
    label: "OpenProject",
    mark: "OP",
    description: "Work package context provider",
    capability: "Import work package details and repository evidence",
  },
  graphify: {
    id: "graphify",
    label: "Graphify",
    mark: "GF",
    description: "Workspace knowledge index",
    capability: "Build a graph scoped to the active worktree set",
  },
  codex: {
    id: "codex",
    label: "Codex",
    mark: "CX",
    description: "Coding agent provider",
    capability: "Open the interactive CLI at the generated workspace root",
  },
  openCode: {
    id: "openCode",
    label: "OpenCode",
    mark: "OC",
    description: "Terminal-native agent provider",
    capability: "Open the native terminal UI in workspace context",
  },
  hermes: {
    id: "hermes",
    label: "Hermes",
    mark: "HM",
    description: "Interactive agent provider",
    capability: "Open the native CLI at the generated workspace root",
  },
  vscode: {
    id: "vscode",
    label: "VS Code",
    mark: "VS",
    description: "Workspace editor",
    capability: "Open the generated multi-root workspace",
  },
  warp: {
    id: "warp",
    label: "Warp",
    mark: "WP",
    description: "Workspace terminal",
    capability: "Open provider CLIs at the validated workspace root",
  },
};

const integrationGroups = [
  {
    label: "Workspace core",
    ids: ["git", "vscode"] satisfies SetupIntegrationId[],
  },
  {
    label: "Terminals",
    ids: ["warp"] satisfies SetupIntegrationId[],
  },
  {
    label: "Issue context",
    ids: ["jiraMcp", "openProject", "graphify"] satisfies SetupIntegrationId[],
  },
  {
    label: "Agent providers",
    ids: ["codex", "openCode", "hermes"] satisfies SetupIntegrationId[],
  },
];

const blockingLabels: Record<SetupBlockingCapability, string> = {
  worktreeMaterialization: "Worktree creation is blocked",
  vscodeLaunch: "Opening the workspace in VS Code is unavailable",
  warpLaunch: "Opening a workspace CLI in Warp is unavailable",
  codexLaunch: "Launching a Codex session is unavailable",
  openCodeLaunch: "Launching an OpenCode session is unavailable",
  hermesLaunch: "Launching a Hermes session is unavailable",
  graphIndexing: "Workspace graph indexing is unavailable",
  jiraIssueImport: "Jira issue import is unavailable",
  openProjectWorkPackageImport: "OpenProject work package import is unavailable",
};

const capabilityLabels: Record<SetupCapability, string> = {
  worktreeMaterialization: "Create isolated Git worktrees",
  workspaceLaunch: "Open a multi-root workspace",
  terminalSession: "Open a workspace-scoped terminal session",
  agentSession: "Run a workspace-scoped agent session",
  graphIndexing: "Build a workspace-only code graph",
  jiraIssueImport: "Import issue context and repository evidence",
  openProjectWorkPackageImport:
    "Import work package context and repository evidence",
};

function Icon({
  name,
  size = 16,
}: {
  name:
    | "check"
    | "close"
    | "folder"
    | "general"
    | "plug"
    | "refresh"
    | "shield"
    | "warning";
  size?: number;
}) {
  const paths: Record<typeof name, ReactNode> = {
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    folder: (
      <path d="M3.5 7.5h6l1.8 2H20.5v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2zM3.5 7.5v-1.5a2 2 0 0 1 2-2h3l1.8 2H14" />
    ),
    general: (
      <>
        <path d="M5 7h14M5 17h14" />
        <circle cx="9" cy="7" r="2" />
        <circle cx="15" cy="17" r="2" />
      </>
    ),
    plug: (
      <>
        <path d="M8 12V6m8 6V6M6 10h12v2a6 6 0 0 1-6 6v3" />
        <path d="M6 6h4m4 0h4" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5" />
        <path d="M18.5 16a7.5 7.5 0 1 1-.3-8.3L20 10" />
      </>
    ),
    shield: (
      <>
        <path d="M12 3.5 19 6v5.2c0 4.3-2.8 7.6-7 9.3-4.2-1.7-7-5-7-9.3V6z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
    warning: (
      <>
        <path d="M12 4 3.5 19h17z" />
        <path d="M12 9v4M12 16.5v.1" />
      </>
    ),
  };

  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      <g
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      >
        {paths[name]}
      </g>
    </svg>
  );
}

function verificationTone(
  integration: SetupIntegration | undefined,
  loading: boolean,
): VerificationTone {
  if (loading && !integration) return "checking";
  if (!integration) return "unchecked";
  if (integration.status === "error" || integration.runtime === "failed") {
    return "failed";
  }
  if (
    integration.installation === "missing" ||
    integration.installation === "unsupported" ||
    integration.status === "notFound"
  ) {
    return "unavailable";
  }
  if (
    integration.setup === "needsAuth" ||
    integration.setup === "unverified"
  ) {
    return "auth";
  }
  if (
    integration.setup === "needsDependency" ||
    integration.setup === "incompatible" ||
    integration.status === "notConfigured"
  ) {
    return "setup";
  }
  if (
    integration.installation === "detected" &&
    integration.status === "ready"
  ) {
    return "verified";
  }
  return "unchecked";
}

function verificationLabel(
  tone: VerificationTone,
  integration: SetupIntegration | undefined,
) {
  switch (tone) {
    case "verified":
      return "Verified";
    case "auth":
      return integration?.setup === "needsAuth"
        ? "Sign-in required"
        : "Auth not checked";
    case "setup":
      return "Setup required";
    case "unavailable":
      return "Unavailable";
    case "failed":
      return "Check failed";
    case "checking":
      return "Checking";
    default:
      return "Not checked";
  }
}

function localCheckLabel(integration: SetupIntegration | undefined) {
  if (!integration) return "Not checked";
  if (integration.status === "error" || integration.runtime === "failed") {
    return integration.verificationKind === "configurationSignal"
      ? "Configuration check failed"
      : "Version check failed";
  }

  if (integration.verificationKind === "configurationSignal") {
    return integration.installation === "detected"
      ? "Configuration signal found"
      : "Configuration signal missing";
  }

  switch (integration?.installation) {
    case "detected":
      return "Version probe passed";
    case "missing":
      return "Executable not found";
    case "unsupported":
      return "Unsupported installation";
    default:
      return "Not checked";
  }
}

function accountLabel(integration: SetupIntegration | undefined) {
  if (!integration) return "Not checked";
  if (integration.id === "git" || integration.id === "vscode") {
    return "Not applicable";
  }
  if (integration.id === "graphify") {
    return "Not checked";
  }
  if (
    (integration.id === "jiraMcp" || integration.id === "openProject") &&
    integration.installation === "missing"
  ) {
    return integration.id === "jiraMcp"
      ? "Connector not configured"
      : "Environment not configured";
  }
  if (integration.id === "openProject" && integration.setup === "needsAuth") {
    return "API token not configured";
  }

  switch (integration?.setup) {
    case "notRequired":
      return "Not applicable";
    case "needsAuth":
      return "Sign-in required";
    case "unverified":
      return "Authentication not checked";
    case "needsDependency":
      return "Dependency required";
    case "ready":
      return "Configuration verified";
    case "incompatible":
      return "Incompatible configuration";
    default:
      return "Not checked";
  }
}

function nextAction(
  integration: SetupIntegration | undefined,
  definition: IntegrationDefinition,
  loading: boolean,
) {
  if (loading && !integration) return "Wait for the current check to finish.";
  if (!integration) return "Run checks to inspect this integration.";
  if (integration.status === "error" || integration.runtime === "failed") {
    return "Review the reported diagnostic, then run checks again.";
  }
  if (definition.id === "openProject" && integration.setup === "needsAuth") {
    return "Configure the OpenProject API token in the WTS environment, then run checks again.";
  }
  if (
    integration.installation === "missing" ||
    integration.setup === "needsDependency"
  ) {
    if (integration.wtsSupport === "detectionOnly") {
      return definition.id === "jiraMcp"
        ? "Add a supported Jira stdio registration in VS Code to use the WTS adapter."
        : `${definition.label} is optional for the working Git workflow.`;
    }
    if (definition.id === "openProject") {
      return "Configure the OpenProject URL and API token in the WTS environment, then run checks again.";
    }
    return `Install or configure ${definition.label}, then run checks again.`;
  }
  if (integration.wtsSupport === "detectionOnly") {
    return definition.id === "jiraMcp"
      ? "WTS found an HTTP configuration signal, but this adapter requires a supported stdio registration."
      : `${definition.label} is detected but has no runnable local action.`;
  }
  if (
    integration.wtsSupport === "available" &&
    integration.installation === "detected" &&
    (integration.setup === "needsAuth" || integration.setup === "unverified")
  ) {
    if (definition.id === "jiraMcp") {
      return "Select Connect Jira. If Podman is unavailable, WTS can use uv to download the Jira adapter.";
    }
    if (definition.id === "openProject") {
      return "Verify the configured OpenProject API before importing a work package.";
    }
    return `Run ${definition.label} from a materialized workspace; sign-in is checked by the provider.`;
  }
  if (integration.status === "ready") return "No action needed.";
  if (
    integration.setup === "needsAuth" ||
    integration.setup === "unverified"
  ) {
    return `Sign in using ${definition.label} itself, then run checks again.`;
  }
  if (integration.setup === "incompatible") {
    return "Update the local tool to a supported version, then run checks again.";
  }
  if (definition.id === "jiraMcp") {
    return "Add a supported Jira stdio registration in VS Code, then verify the connection.";
  }
  if (definition.id === "openProject") {
    return "Configure OpenProject in the WTS environment, then verify the connection.";
  }
  return `Finish configuring ${definition.label}, then run checks again.`;
}

function supportLabel(integration: SetupIntegration | undefined) {
  switch (integration?.wtsSupport) {
    case "available":
      return "Available in this MVP";
    case "detectionOnly":
      return "This configuration type is detection only";
    default:
      return "Not reported";
  }
}

function formatCheckedAt(value: number | undefined, prefix = "Checked") {
  if (!value) return "Not checked yet";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Check time unavailable";
  return `${prefix} ${date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function IntegrationRow({
  definition,
  integration,
  loading,
  snapshotCheckedAt,
  onVerifyJira,
  onVerifyOpenProject,
}: {
  definition: IntegrationDefinition;
  integration?: SetupIntegration;
  loading: boolean;
  snapshotCheckedAt?: number;
  onVerifyJira?: () => Promise<JiraMcpVerification>;
  onVerifyOpenProject?: () => Promise<OpenProjectVerification>;
}) {
  const [adapterCheck, setAdapterCheck] = useState<
    "idle" | "checking" | "ready" | "error"
  >("idle");
  const [adapterMessage, setAdapterMessage] = useState("");
  const adapterGeneration = useRef(0);
  useEffect(() => {
    adapterGeneration.current += 1;
    setAdapterCheck("idle");
    setAdapterMessage("");
    return () => {
      adapterGeneration.current += 1;
    };
  }, [integration, snapshotCheckedAt]);
  const tone = verificationTone(integration, loading);
  const consequences =
    integration?.blockingFor.map((capability) => blockingLabels[capability]) ??
    [];
  const availableToWts =
    integration?.wtsSupport === "available" &&
    integration.installation === "detected" &&
    consequences.length === 0;
  const adapterActionAvailable =
    (definition.id === "jiraMcp" && Boolean(onVerifyJira)) ||
    (definition.id === "openProject" &&
      integration?.setup === "unverified" &&
      !integration.blockingFor.includes("openProjectWorkPackageImport") &&
      Boolean(onVerifyOpenProject));

  const verifyAdapter = async () => {
    const requestGeneration = adapterGeneration.current;
    setAdapterCheck("checking");
    setAdapterMessage("");
    try {
      if (definition.id === "jiraMcp" && onVerifyJira) {
        const result = await onVerifyJira();
        if (requestGeneration !== adapterGeneration.current) return;
        setAdapterMessage(
          `${result.serverName} ${result.serverVersion} exposed ${result.issueTool}.`,
        );
      } else if (definition.id === "openProject" && onVerifyOpenProject) {
        const result = await onVerifyOpenProject();
        if (requestGeneration !== adapterGeneration.current) return;
        setAdapterMessage(
          `${result.instanceName} answered OpenProject ${result.apiVersion} as ${result.authenticatedUser}.`,
        );
      } else {
        return;
      }
      setAdapterCheck("ready");
    } catch (error) {
      if (requestGeneration !== adapterGeneration.current) return;
      setAdapterMessage(
        error instanceof Error
          ? error.message
          : `${definition.label} verification failed.`,
      );
      setAdapterCheck("error");
    }
  };

  return (
    <li className={styles.integrationRow}>
      <div className={styles.integrationLead}>
        <span className={styles.integrationMark} aria-hidden="true">
          {definition.mark}
        </span>
        <span className={styles.integrationIdentity}>
          <span>
            <b>{definition.label}</b>
            {integration?.version && (
              <code aria-label={`${definition.label} version`}>
                v{integration.version}
              </code>
            )}
          </span>
          <small>{definition.description}</small>
        </span>
        <span className={styles.statusBadge} data-tone={tone}>
          <i />
          {verificationLabel(tone, integration)}
        </span>
      </div>

      <div className={styles.integrationOutcome}>
        <span data-clear={availableToWts || undefined}>
          {availableToWts ? (
            <>
              <Icon name="check" size={13} />
              {tone === "verified" ? "Available to WTS" : "WTS adapter ready"}
            </>
          ) : integration?.wtsSupport === "detectionOnly" ? (
            <>
              <Icon name="warning" size={13} />
              Adapter needs a supported local configuration
            </>
          ) : consequences.length ? (
            <>
              <Icon name="warning" size={13} />
              {consequences.join(" · ")}
            </>
          ) : (
            <>
              <Icon name="warning" size={13} />
              Local state has not been verified
            </>
          )}
        </span>
        <small>
          <b>Next:</b> {nextAction(integration, definition, loading)}
        </small>
        {(definition.id === "jiraMcp" ||
          definition.id === "openProject") &&
          integration?.installation === "detected" &&
          adapterActionAvailable && (
            <button
              className={styles.adapterVerifyButton}
              disabled={adapterCheck === "checking" || adapterCheck === "ready"}
              onClick={() => void verifyAdapter()}
              type="button"
            >
              {adapterCheck === "checking"
                ? "Connecting…"
                : adapterCheck === "ready"
                  ? "Connected"
                  : adapterCheck === "error"
                    ? "Try again"
                    : definition.id === "jiraMcp"
                      ? "Connect Jira"
                      : "Verify connection"}
            </button>
          )}
        {adapterMessage && (
          <small
            className={styles.adapterCheckMessage}
            data-error={adapterCheck === "error" || undefined}
            role={adapterCheck === "error" ? "alert" : "status"}
          >
            {adapterMessage}
          </small>
        )}
      </div>

      {(definition.id === "jiraMcp" ||
        definition.id === "openProject") &&
        integration?.installation === "detected" &&
        integration.detail && (
          <p className={styles.externalConnectionNotice}>
            <Icon name="plug" size={14} />
            {integration.detail}
          </p>
        )}

      <details className={styles.integrationDetails}>
        <summary>
          <span>Verification details</span>
          <small>{localCheckLabel(integration)}</small>
        </summary>
        <dl className={styles.integrationFacts}>
          <div>
            <dt>Local check</dt>
            <dd>{localCheckLabel(integration)}</dd>
          </div>
          <div>
            <dt>Account</dt>
            <dd>{accountLabel(integration)}</dd>
          </div>
          <div>
            <dt>WTS support</dt>
            <dd>{supportLabel(integration)}</dd>
          </div>
          <div className={styles.capabilityFact}>
            <dt>Capability</dt>
            <dd>
              {integration?.capabilities?.length
                ? integration.capabilities
                    .map((capability) => capabilityLabels[capability])
                    .join(", ")
                : definition.capability}
            </dd>
          </div>
        </dl>

        {integration?.detail && (
          <p className={styles.diagnostic}>
            <span>Reported</span>
            {integration.detail}
            {integration.diagnosticCode && (
              <code>{integration.diagnosticCode}</code>
            )}
          </p>
        )}

        <div className={styles.detailsFooter}>
          <span>{consequences.join(" · ") || "No blocked WTS capability"}</span>
          <time>
            {formatCheckedAt(
              integration?.lastProbeAt ?? snapshotCheckedAt,
              "Last check",
            )}
          </time>
        </div>
      </details>
    </li>
  );
}

function gitSigningNextAction(
  signing: SetupSnapshot["gitSigning"],
  loading: boolean,
) {
  if (loading && !signing) return "Wait for the current check to finish.";
  switch (signing?.diagnosticCode) {
    case "gitUnavailable":
      return "Install Git, then run checks again.";
    case "commitSigningDisabled":
      return "Enable global Git commit signing, then run checks again.";
    case "signingKeyNotConfigured":
      return "Configure a global Git signing key, then run checks again.";
    case "gpgExecutableMissing":
      return "Install GPG, then run checks again.";
    case "privateKeyUnavailable":
      return "Import the configured private key, then run checks again.";
    default:
      return signing?.ready
        ? "No action needed."
        : "Run checks to inspect Git signing.";
  }
}

function GitSigningRow({
  signing,
  loading,
  snapshotCheckedAt,
}: {
  signing: SetupSnapshot["gitSigning"];
  loading: boolean;
  snapshotCheckedAt?: number;
}) {
  const tone: VerificationTone = signing?.ready
    ? "verified"
    : loading && !signing
      ? "checking"
      : signing
        ? "setup"
        : "unchecked";

  return (
    <li
      className={styles.integrationRow}
      data-ui="environment.git-signing"
      data-ui-label="Git signing check"
    >
      <div className={styles.integrationLead}>
        <span className={styles.integrationMark} aria-hidden="true">GP</span>
        <span className={styles.integrationIdentity}>
          <span><b>GPG commit signing</b></span>
          <small>Global Git OpenPGP signing readiness</small>
        </span>
        <span className={styles.statusBadge} data-tone={tone}>
          <i />
          {signing?.ready
            ? "Ready"
            : loading && !signing
              ? "Checking"
              : signing
                ? "Needs setup"
                : "Not checked"}
        </span>
      </div>
      <div className={styles.integrationOutcome}>
        <span data-clear={signing?.ready || undefined}>
          <Icon name={signing?.ready ? "check" : "warning"} size={13} />
          {signing?.detail ?? "Git signing has not been checked."}
        </span>
        <small><b>Next:</b> {gitSigningNextAction(signing, loading)}</small>
      </div>
      <details className={styles.integrationDetails}>
        <summary>
          <span>Verification details</span>
          <small>{signing?.ready ? "All checks passed" : "Setup is incomplete"}</small>
        </summary>
        <dl className={styles.integrationFacts}>
          <div>
            <dt>Commit signing</dt>
            <dd>{signing?.commitSigningEnabled ? "Enabled" : "Disabled"}</dd>
          </div>
          <div>
            <dt>Signing key</dt>
            <dd>{signing?.signingKeyConfigured ? "Configured" : "Not configured"}</dd>
          </div>
          <div>
            <dt>GPG</dt>
            <dd>{signing?.gpgAvailable ? "Available" : "Unavailable"}</dd>
          </div>
          <div>
            <dt>Private key</dt>
            <dd>{signing?.privateKeyAvailable ? "Available" : "Unavailable"}</dd>
          </div>
        </dl>
        <div className={styles.detailsFooter}>
          <span>{signing?.diagnosticCode ?? "No signing problem found"}</span>
          <time>{formatCheckedAt(snapshotCheckedAt, "Last check")}</time>
        </div>
      </details>
    </li>
  );
}

function RefreshButton({
  loading,
  onRefresh,
  compact = false,
}: {
  loading: boolean;
  onRefresh: () => void;
  compact?: boolean;
}) {
  return (
    <button
      className={styles.refreshButton}
      data-compact={compact || undefined}
      disabled={loading}
      onClick={onRefresh}
      type="button"
    >
      <span data-spinning={loading || undefined}>
        <Icon name="refresh" size={14} />
      </span>
      {loading ? "Verifying…" : compact ? "Rescan" : "Verify all"}
    </button>
  );
}

function IntegrationsPanel({
  client,
  gitlabWorkspaceId,
  snapshot,
  integrations,
  loading,
  onRefresh,
  onVerifyJira,
  onVerifyOpenProject,
}: {
  client?: WorkspaceClient;
  gitlabWorkspaceId?: string;
  snapshot?: SetupSnapshot;
  integrations: Map<SetupIntegrationId, SetupIntegration>;
  loading: boolean;
  onRefresh: () => void;
  onVerifyJira?: () => Promise<JiraMcpVerification>;
  onVerifyOpenProject?: () => Promise<OpenProjectVerification>;
}) {
  const definitions = Object.values(integrationDefinitions);
  const counts = definitions.reduce(
    (result, definition) => {
      const tone = verificationTone(integrations.get(definition.id), loading);
      if (tone === "verified") result.verified += 1;
      if (tone === "auth") result.auth += 1;
      if (
        tone === "setup" ||
        tone === "unavailable" ||
        tone === "failed"
      ) {
        result.attention += 1;
      }
      return result;
    },
    { verified: 0, auth: 0, attention: 0 },
  );

  return (
    <section
      aria-labelledby="preferences-integrations-title"
      className={styles.preferencePanel}
      data-ui="environment.integrations"
      data-ui-label="Integrations settings"
    >
      <header className={styles.panelHeader}>
        <div>
          <span className={styles.eyebrow}>LOCAL CAPABILITIES</span>
          <h3 id="preferences-integrations-title">Integrations</h3>
          <p>
            Verify the tools WTS can safely use. Checks are read-only and do
            not launch a provider.
          </p>
        </div>
        <RefreshButton
          loading={loading}
          onRefresh={onRefresh}
        />
      </header>

      <div className={styles.verificationSummary} aria-live="polite">
        <span>
          <b>{counts.verified}</b>
          verified
        </span>
        <span data-tone="auth">
          <b>{counts.auth}</b>
          auth unverified
        </span>
        <span data-tone="attention">
          <b>{counts.attention}</b>
          need attention
        </span>
        <small>{formatCheckedAt(snapshot?.checkedAtUnixMs)}</small>
      </div>

      <div className={styles.scopeNote}>
        <Icon name="shield" size={16} />
        <span>
          <b>What “verified” means</b>
          The automatic check only probes local tools and host configuration.
          A remote handshake runs only when you explicitly choose Verify
          connection.
        </span>
      </div>

      {integrationGroups.map((group) => (
        <section className={styles.integrationGroup} key={group.label}>
          <h4>{group.label}</h4>
          <ul className={styles.integrationList}>
            {group.label === "Workspace core" && client && (
              <GitlabIntegrationCard
                client={client}
                workspaceId={gitlabWorkspaceId}
              />
            )}
            {group.ids.map((id) => (
              <Fragment key={id}>
                <IntegrationRow
                  definition={integrationDefinitions[id]}
                  integration={integrations.get(id)}
                  loading={loading}
                  snapshotCheckedAt={snapshot?.checkedAtUnixMs}
                  onVerifyJira={onVerifyJira}
                  onVerifyOpenProject={onVerifyOpenProject}
                />
                {id === "git" && (
                  <GitSigningRow
                    loading={loading}
                    signing={snapshot?.gitSigning}
                    snapshotCheckedAt={snapshot?.checkedAtUnixMs}
                  />
                )}
              </Fragment>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}

function RepositoriesPanel({
  repositories,
  expectedCount,
  loading,
  onRefresh,
}: {
  repositories?: RepositoryCatalog;
  expectedCount?: number;
  loading: boolean;
  onRefresh: () => void;
}) {
  const rows = repositories?.repositories;
  const count = rows?.length ?? expectedCount;

  return (
    <section
      aria-labelledby="preferences-repositories-title"
      className={styles.preferencePanel}
      data-ui="environment.repositories"
      data-ui-label="Repository settings"
    >
      <header className={styles.panelHeader}>
        <div>
          <span className={styles.eyebrow}>LOCAL CATALOG</span>
          <h3 id="preferences-repositories-title">Repositories</h3>
          <p>
            WTS runs a bounded nested scan across configured trusted local
            roots.
          </p>
        </div>
        <RefreshButton compact loading={loading} onRefresh={onRefresh} />
      </header>

      <div className={styles.repositoryRoot}>
        <span className={styles.rootIcon}>
          <Icon name="folder" size={17} />
        </span>
        <span>
          <small>Primary trusted repository root</small>
          <code>
            {repositories?.repositoryRootDisplayPath ?? "Not reported"}
          </code>
        </span>
        <strong>
          {typeof count === "number"
            ? `${count} ${count === 1 ? "repository" : "repositories"}`
            : "Not scanned"}
        </strong>
      </div>

      {typeof repositories?.skippedEntries === "number" &&
        repositories.skippedEntries > 0 && (
          <div className={styles.skippedNotice}>
            <Icon name="warning" size={14} />
            {repositories.skippedEntries}{" "}
            {repositories.skippedEntries === 1 ? "entry was" : "entries were"}{" "}
            skipped because WTS could not safely inspect them.
          </div>
        )}

      {loading && !rows ? (
        <div className={styles.emptyState} role="status">
          <span className={styles.spinner}>
            <Icon name="refresh" size={19} />
          </span>
          <b>Scanning for nested repositories</b>
          <small>This does not fetch, clone, or modify repositories.</small>
        </div>
      ) : rows?.length ? (
        <ul className={styles.repositoryList}>
          {rows.map((repository) => (
            <li className={styles.repositoryRow} key={repository.id}>
              <span className={styles.repositoryIcon} aria-hidden="true">
                <Icon name="folder" size={15} />
              </span>
              <span className={styles.repositoryIdentity}>
                <b>{repository.label}</b>
                <code>{repository.displayPath}</code>
                {repository.checkoutLeaf !== repository.label && (
                  <small>Checkout folder · {repository.checkoutLeaf}</small>
                )}
                {repository.originUrl && <small>{repository.originUrl}</small>}
              </span>
              <span className={styles.branchMeta}>
                <small>Default branch</small>
                <b>{repository.defaultBranch.name}</b>
                <code title={repository.defaultBranch.commitOid}>
                  {repository.defaultBranch.commitOid.slice(0, 8)}
                </code>
              </span>
            </li>
          ))}
        </ul>
      ) : rows ? (
        <div className={styles.emptyState}>
          <span>
            <Icon name="folder" size={19} />
          </span>
          <b>No repositories discovered</b>
          <small>
            Add a Git repository beneath the configured root, then rescan.
          </small>
        </div>
      ) : (
        <div className={styles.emptyState}>
          <span>
            <Icon name="folder" size={19} />
          </span>
          <b>Repository details have not been loaded</b>
          <small>Run a rescan to read the local catalog.</small>
        </div>
      )}
    </section>
  );
}

function GeneralPanel({
  snapshot,
  repositories,
  loading,
  onRefresh,
}: {
  snapshot?: SetupSnapshot;
  repositories?: RepositoryCatalog;
  loading: boolean;
  onRefresh: () => void;
}) {
  const { preference, resolvedTheme, setPreference } = useTheme();
  const {
    preference: workspaceCardClickPreference,
    setPreference: setWorkspaceCardClickPreference,
  } = useWorkspaceCardClickPreference();
  const git = snapshot?.integrations.find(
    (integration) => integration.id === "git",
  );
  const repositoryCount =
    repositories?.repositories.length ?? snapshot?.repositoryCount;
  const ready =
    git?.status === "ready" && typeof repositoryCount === "number" &&
    repositoryCount > 0;
  const browserReadiness = snapshot?.browserJourneyReadiness;
  const browserState = loading
    ? "checking"
    : browserReadiness?.ready
      ? "ready"
      : browserReadiness
        ? "attention"
        : "unchecked";
  const browserChecks: Array<{
    id: keyof Pick<
      BrowserJourneyReadiness,
      "node" | "fixedHelper" | "playwright" | "chromium"
    >;
    label: string;
    check?: BrowserJourneyReadinessCheck;
  }> = [
    { id: "node", label: "Node executable", check: browserReadiness?.node },
    {
      id: "fixedHelper",
      label: "Fixed helper",
      check: browserReadiness?.fixedHelper,
    },
    {
      id: "playwright",
      label: "Playwright module",
      check: browserReadiness?.playwright,
    },
    {
      id: "chromium",
      label: "Chromium build",
      check: browserReadiness?.chromium,
    },
  ];
  const sourceLabels = {
    configured: "Configured",
    packaged: "Packaged",
    path: "Found on PATH",
  } as const;
  const themeOptions: Array<{
    id: ThemePreference;
    label: string;
    detail: string;
  }> = [
    {
      id: "light",
      label: "Light",
      detail: "Bright surfaces for daylight and high ambient light.",
    },
    {
      id: "system",
      label: "System",
      detail: `Follow macOS. Currently using ${resolvedTheme} mode.`,
    },
    {
      id: "dark",
      label: "Dark",
      detail: "Low-glare surfaces for terminals and focused sessions.",
    },
  ];
  const cardClickOptions: Array<{
    id: WorkspaceCardClickPreference;
    label: string;
    detail: string;
  }> = [
    {
      id: "details",
      label: "Details first",
      detail: "Click for details. Command-click opens the workspace in VS Code.",
    },
    {
      id: "workspace",
      label: "Workspace first",
      detail: "Click opens VS Code. Command-click opens the internal details page.",
    },
  ];

  return (
    <section
      aria-labelledby="preferences-general-title"
      className={styles.preferencePanel}
      data-ui="environment.general"
      data-ui-label="General settings"
    >
      <header className={styles.panelHeader}>
        <div>
          <span className={styles.eyebrow}>WTS ON THIS COMPUTER</span>
          <h3 id="preferences-general-title">General</h3>
          <p>The local requirements and safety boundary for new workspaces.</p>
        </div>
        <RefreshButton loading={loading} onRefresh={onRefresh} />
      </header>

      <div className={styles.readinessCard} data-ready={ready || undefined}>
        <span>
          {ready ? (
            <Icon name="check" size={22} />
          ) : (
            <Icon name="warning" size={22} />
          )}
        </span>
        <div>
          <b>{ready ? "Ready to create worktrees" : "Core setup needs attention"}</b>
          <p>
            {ready
              ? `Git is ready, and ${repositoryCount} local ${
                  repositoryCount === 1 ? "repository is" : "repositories are"
                } available.`
              : "WTS needs Git and at least one discovered repository before it can materialize a workspace."}
          </p>
        </div>
      </div>

      <section className={styles.settingsBlock}>
        <header>
          <h4>Appearance</h4>
          <p>Choose how WTS looks on this computer.</p>
        </header>
        <fieldset
          aria-label="Color theme"
          className={styles.themePicker}
        >
          <legend>Color theme</legend>
          {themeOptions.map((option) => (
            <label
              data-selected={preference === option.id || undefined}
              key={option.id}
            >
              <input
                checked={preference === option.id}
                name="wts-color-theme"
                onChange={() => setPreference(option.id)}
                type="radio"
                value={option.id}
              />
              <span
                aria-hidden="true"
                className={styles.themePreview}
                data-theme-preview={option.id}
              >
                <i />
                <i />
                <i />
              </span>
              <span>
                <b>{option.label}</b>
                <small>{option.detail}</small>
              </span>
              <i aria-hidden="true" className={styles.themeCheck} />
            </label>
          ))}
        </fieldset>
      </section>

      <section className={styles.settingsBlock}>
        <header>
          <h4>Workspace cards</h4>
          <p>Choose the primary action for cards with an open workspace.</p>
        </header>
        <fieldset
          aria-label="Workspace card click action"
          className={`${styles.themePicker} ${styles.cardBehaviorPicker}`}
        >
          <legend>Workspace card click action</legend>
          {cardClickOptions.map((option) => (
            <label
              data-selected={
                workspaceCardClickPreference === option.id || undefined
              }
              key={option.id}
            >
              <input
                checked={workspaceCardClickPreference === option.id}
                name="wts-workspace-card-click"
                onChange={() => setWorkspaceCardClickPreference(option.id)}
                type="radio"
                value={option.id}
              />
              <span
                aria-hidden="true"
                className={styles.cardBehaviorPreview}
                data-action={option.id}
              >
                <i />
                <i />
              </span>
              <span>
                <b>{option.label}</b>
                <small>{option.detail}</small>
              </span>
              <i aria-hidden="true" className={styles.themeCheck} />
            </label>
          ))}
        </fieldset>
      </section>

      <section className={styles.settingsBlock}>
        <header className={styles.runnerHeader}>
          <div>
            <h4>Browser journeys</h4>
            <p>
              Deterministic UI checks run locally without an agent provider.
            </p>
          </div>
          <span className={styles.runnerState} data-state={browserState}>
            {browserState === "checking"
              ? "Checking"
              : browserState === "ready"
                ? "Ready"
                : browserState === "attention"
                  ? "Needs setup"
                  : "Not checked"}
          </span>
        </header>
        <dl className={`${styles.settingsList} ${styles.runnerChecks}`}>
          {browserChecks.map(({ id, label, check }) => (
            <div data-state={check?.status ?? "unchecked"} key={id}>
              <dt>
                <i aria-hidden="true" />
                {label}
              </dt>
              <dd>
                <b>
                  {check?.status === "ready"
                    ? check.source
                      ? sourceLabels[check.source]
                      : "Available"
                    : check?.status === "blocked"
                      ? "Waiting for prerequisite"
                      : check
                        ? "Unavailable"
                        : loading
                          ? "Checking"
                          : "Not checked"}
                </b>
                <small>
                  {check?.detail ??
                    (loading
                      ? "Waiting for the local WTS service."
                      : "Run Verify all to inspect this prerequisite.")}
                </small>
              </dd>
            </div>
          ))}
        </dl>
        <p className={styles.runnerBoundary}>
          WTS resolves local files and asks Playwright for Chromium’s executable
          path. This check does not open a browser or contact the network.
        </p>
      </section>

      <section className={styles.settingsBlock}>
        <header>
          <h4>Verification behavior</h4>
          <p>How this version of WTS checks your environment.</p>
        </header>
        <dl className={styles.settingsList}>
          <div>
            <dt>Check mode</dt>
            <dd>
              <b>Read-only</b>
              <small>
                No provider or browser is launched and no repository is changed.
              </small>
            </dd>
          </div>
          <div>
            <dt>Execution</dt>
            <dd>
              <b>Local only</b>
              <small>Commands run on this computer through the WTS service.</small>
            </dd>
          </div>
          <div>
            <dt>Provider authentication</dt>
            <dd>
              <b>Reported separately</b>
              <small>
                Executable detection does not prove that an agent is signed in.
              </small>
            </dd>
          </div>
        </dl>
      </section>

      <div className={styles.generalFootnote}>
        <Icon name="shield" size={16} />
        This view reports detected configuration. Editable paths and launch
        defaults will appear here as they become available.
      </div>
    </section>
  );
}

export function SetupSheet({
  open,
  onOpenChange,
  snapshot,
  repositories,
  loading,
  error,
  onRefresh,
  onVerifyJira,
  onVerifyOpenProject,
  client,
  gitlabWorkspaceId,
  appUpdate,
}: SetupSheetProps) {
  const dialogFocusReturn = useDialogFocusReturn();
  const [activeSection, setActiveSection] =
    useState<PreferenceSection>("integrations");

  const integrations = new Map(
    snapshot?.integrations.map(
      (integration) => [integration.id, integration] as const,
    ),
  );
  const repositoryCount =
    repositories?.repositories.length ?? snapshot?.repositoryCount;
  const navigation: Array<{
    id: PreferenceSection;
    label: string;
    detail: string;
    icon: "general" | "folder" | "plug" | "refresh";
    badge?: number;
  }> = [
    {
      id: "general",
      label: "General",
      detail: "Local behavior",
      icon: "general",
    },
    {
      id: "repositories",
      label: "Repositories",
      detail: "Discovery folder",
      icon: "folder",
      badge: repositoryCount,
    },
    {
      id: "integrations",
      label: "Integrations",
      detail: "Tools & providers",
      icon: "plug",
      badge: snapshot?.integrations.length,
    },
    {
      id: "updates",
      label: "Updates",
      detail: "Version and restart",
      icon: "refresh",
    },
  ];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          {...dialogFocusReturn}
          aria-describedby="environment-integrations-description"
          aria-modal="true"
          className={styles.modal}
          data-ui="environment.dialog"
          data-ui-label="Environment and integrations"
        >
          <header className={styles.modalHeader}>
            <div>
              <Dialog.Title>Environment &amp; integrations</Dialog.Title>
              <Dialog.Description id="environment-integrations-description">
                Review local tools, repository discovery, and WTS
                configuration.
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Close environment and integrations"
              className={styles.closeButton}
            >
              <Icon name="close" />
            </Dialog.Close>
          </header>

          <Tabs.Root
            className={styles.preferencesBody}
            onValueChange={(value) =>
              setActiveSection(value as PreferenceSection)
            }
            orientation="vertical"
            value={activeSection}
          >
            <aside
              className={styles.sidebar}
              data-ui="environment.navigation"
              data-ui-label="Settings navigation"
            >
              <Tabs.List
                aria-label="Environment and integrations sections"
                className={styles.sectionTabs}
              >
                {navigation.map((item) => (
                  <Tabs.Trigger
                    key={item.id}
                    value={item.id}
                  >
                    <span className={styles.navIcon}>
                      <Icon name={item.icon} size={16} />
                    </span>
                    <span>
                      <b>{item.label}</b>
                      <small>{item.detail}</small>
                    </span>
                    {typeof item.badge === "number" && <i>{item.badge}</i>}
                  </Tabs.Trigger>
                ))}
              </Tabs.List>

              <div
                aria-live="polite"
                className={styles.sidebarStatus}
                role="status"
              >
                <span
                  data-state={
                    error ? "error" : loading ? "checking" : snapshot ? "ready" : "idle"
                  }
                />
                <div>
                  <b>
                    {loading
                      ? "Running checks"
                      : error
                        ? "Check interrupted"
                        : "Local service"}
                  </b>
                  <small>{formatCheckedAt(snapshot?.checkedAtUnixMs)}</small>
                </div>
              </div>
            </aside>

            <main
              className={styles.content}
              data-ui="environment.content"
              data-ui-label="Settings content"
            >
              {error && (
                <div className={styles.errorNotice} role="alert">
                  <Icon name="warning" size={16} />
                  <span>
                    <b>Verification could not finish</b>
                    <small>
                      {error} Previous results remain visible where available.
                    </small>
                  </span>
                  <button disabled={loading} onClick={onRefresh} type="button">
                    Retry
                  </button>
                </div>
              )}

              <Tabs.Content className={styles.tabPanel} value="general">
                <GeneralPanel
                  loading={loading}
                  onRefresh={onRefresh}
                  repositories={repositories}
                  snapshot={snapshot}
                />
              </Tabs.Content>
              <Tabs.Content className={styles.tabPanel} value="repositories">
                <RepositoriesPanel
                  expectedCount={snapshot?.repositoryCount}
                  loading={loading}
                  onRefresh={onRefresh}
                  repositories={repositories}
                />
              </Tabs.Content>
              <Tabs.Content className={styles.tabPanel} value="integrations">
                <IntegrationsPanel
                  client={client}
                  gitlabWorkspaceId={gitlabWorkspaceId}
                  integrations={integrations}
                  loading={loading}
                  onRefresh={onRefresh}
                  onVerifyJira={onVerifyJira}
                  onVerifyOpenProject={onVerifyOpenProject}
                  snapshot={snapshot}
                />
              </Tabs.Content>
              <Tabs.Content className={styles.tabPanel} value="updates">
                {appUpdate && (
                  <AppUpdateScreen controller={appUpdate} embedded />
                )}
              </Tabs.Content>
            </main>
          </Tabs.Root>

          <footer className={styles.modalFooter}>
            <span>
              <Icon name="shield" size={13} />
              Diagnostics are read-only.
            </span>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
