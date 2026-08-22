import * as Dialog from "@radix-ui/react-dialog";
import {
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type {
  AgentProvider,
  SetupSnapshot,
  TerminalProvider,
  WorkspaceCliLaunchResult,
  WorkspaceMaterialization,
  WorkspaceProvider,
} from "../../lib/wtsClient";
import styles from "./OpenWorkspaceLauncher.module.css";

type LaunchState =
  | "idle"
  | "launching"
  | "openingVscode"
  | "accepted"
  | "error";

export interface PreparedWorkspaceBrief {
  prompt: string;
  state: "saving" | "ready" | "error";
  displayPath?: string;
  error?: string;
}

export interface OpenWorkspaceLauncherProps {
  workspaceId: string;
  workspaceKey: string;
  preferredProvider: WorkspaceProvider;
  materialization: WorkspaceMaterialization;
  integrations?: SetupSnapshot["integrations"];
  preparedBrief?: PreparedWorkspaceBrief;
  onRetryBrief?: () => void;
  onOpenCli: (
    provider: AgentProvider,
    terminal: TerminalProvider,
  ) => Promise<WorkspaceCliLaunchResult>;
  onOpenVscode: () => Promise<boolean>;
  trigger?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const providerNames: Record<AgentProvider, string> = {
  codex: "Codex",
  openCode: "OpenCode",
  hermes: "Hermes",
};

const providerMarks: Record<AgentProvider | "vscode", string> = {
  codex: "CX",
  openCode: "OC",
  hermes: "HM",
  vscode: "VS",
};

const providerCommands: Record<AgentProvider, string> = {
  codex: "codex --sandbox workspace-write --ask-for-approval on-request",
  openCode: "opencode .",
  hermes: "hermes chat --tui",
};

const terminalNames: Record<TerminalProvider, string> = {
  terminal: "Terminal",
  warp: "Warp",
};

function agentProviderFromPreference(
  provider: WorkspaceProvider,
): AgentProvider | null {
  if (provider === "openCode") return "openCode";
  if (provider === "hermes") return "hermes";
  if (provider === "codex") return "codex";
  return null;
}

function preferredTerminal(
  integrations: SetupSnapshot["integrations"] | undefined,
): TerminalProvider {
  const warp = integrations?.find((item) => item.id === "warp");
  return warp?.installation === "detected" && warp.status !== "error"
    ? "warp"
    : "terminal";
}

function providerSetupLabel(
  provider: AgentProvider,
  integrations: SetupSnapshot["integrations"] | undefined,
): string {
  const integration = integrations?.find((item) => item.id === provider);
  if (!integration) return "Setup not checked";
  if (integration.installation === "missing") return "Not detected";
  if (integration.setup === "needsAuth") return "Sign-in may be required";
  if (integration.status === "ready") {
    return integration.version
      ? `Detected · ${integration.version}`
      : "Detected";
  }
  return integration.detail || "Detected · setup may be required";
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
      <rect height="13" rx="2" stroke="currentColor" strokeWidth="1.8" width="13" x="8" y="8" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="17" viewBox="0 0 24 24" width="17">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

export function OpenWorkspaceLauncher({
  workspaceId,
  workspaceKey,
  preferredProvider,
  materialization,
  integrations,
  preparedBrief,
  onRetryBrief,
  onOpenCli,
  onOpenVscode,
  trigger,
  open,
  defaultOpen,
  onOpenChange,
}: OpenWorkspaceLauncherProps) {
  const preferredAgent = agentProviderFromPreference(preferredProvider);
  const initialProvider = preferredAgent ?? "codex";
  const initialTerminal = preferredTerminal(integrations);
  const [provider, setProvider] = useState<AgentProvider>(initialProvider);
  const [terminal, setTerminal] =
    useState<TerminalProvider>(initialTerminal);
  const [state, setState] = useState<LaunchState>("idle");
  const [message, setMessage] = useState("");
  const pending = state === "launching" || state === "openingVscode";
  const warp = integrations?.find((item) => item.id === "warp");
  const warpAvailable =
    warp?.installation === "detected" && warp.status !== "error";
  const briefBlocksAgents =
    preparedBrief !== undefined && preparedBrief.state !== "ready";

  useEffect(() => {
    setProvider(initialProvider);
    setTerminal(initialTerminal);
    setState("idle");
    setMessage("");
  }, [initialProvider, initialTerminal, workspaceId]);

  const copyPath = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable.");
      }
      await navigator.clipboard.writeText(
        materialization.workspaceDisplayPath,
      );
      setState("idle");
      setMessage("Workspace path copied.");
    } catch {
      setState("error");
      setMessage("Could not copy. Select the path manually.");
    }
  };

  const openCli = async (requestedProvider: AgentProvider) => {
    if (pending || briefBlocksAgents) return;
    const requestedTerminal = terminal;
    setProvider(requestedProvider);
    setState("launching");
    setMessage(
      `Opening ${providerNames[requestedProvider]} in ${terminalNames[requestedTerminal]}…`,
    );
    try {
      const result = await onOpenCli(requestedProvider, requestedTerminal);
      if (
        !result.accepted ||
        result.workspaceId !== workspaceId ||
        result.provider !== requestedProvider ||
        result.terminal !== requestedTerminal ||
        result.workspaceDisplayPath !== materialization.workspaceDisplayPath
      ) {
        throw new Error("WTS returned a mismatched CLI launch handoff.");
      }
      setState("accepted");
      setMessage(
        preparedBrief
          ? `${providerNames[requestedProvider]} opened in ${terminalNames[requestedTerminal]}. It can read WTS.md from the workspace root.`
          : `${providerNames[requestedProvider]} opened in ${terminalNames[requestedTerminal]}.`,
      );
    } catch (error) {
      setState("error");
      setMessage(
        error instanceof Error
          ? error.message
          : `${terminalNames[requestedTerminal]} did not accept the launch.`,
      );
    }
  };

  const openVscode = async () => {
    if (pending) return;
    setState("openingVscode");
    setMessage("Opening the workspace in VS Code…");
    try {
      const accepted = await onOpenVscode();
      if (!accepted) {
        throw new Error("VS Code could not open the workspace.");
      }
      setState("accepted");
      setMessage("Workspace opened in VS Code.");
    } catch (error) {
      setState("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "VS Code could not open the workspace.",
      );
    }
  };

  return (
    <Dialog.Root
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      open={open}
    >
      {trigger !== undefined && (
        <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      )}
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          aria-busy={pending || undefined}
          aria-describedby="open-workspace-description"
          className={styles.launcher}
          data-ui="launcher.dialog"
          data-ui-label="Open workspace dialog"
        >
          <header className={styles.header}>
            <div>
              <Dialog.Title>Open workspace</Dialog.Title>
              <Dialog.Description id="open-workspace-description">
                Choose where to continue working in {workspaceKey}.
              </Dialog.Description>
            </div>
            <Dialog.Close aria-label="Close open workspace" className={styles.closeButton}>
              <CloseIcon />
            </Dialog.Close>
          </header>

          <div
            className={styles.pathRow}
            data-ui="launcher.location"
            data-ui-label="Launch location"
          >
            <span>
              <small>WORKING DIRECTORY</small>
              <code title={materialization.workspaceDisplayPath}>
                {materialization.workspaceDisplayPath}
              </code>
            </span>
            <button disabled={pending} onClick={() => void copyPath()} type="button">
              <CopyIcon />
              Copy path
            </button>
          </div>

          <section
            aria-labelledby="recommended-open-title"
            className={styles.section}
            data-ui="launcher.recommended-tools"
            data-ui-label="Recommended tools"
          >
            <div className={styles.sectionHeading}>
              <span>
                <small>RECOMMENDED</small>
                <h3 id="recommended-open-title">Continue with your preferred tool</h3>
              </span>
            </div>

            <div className={styles.primaryChoices}>
              {preferredAgent && (
                <button
                  aria-label={
                    preparedBrief
                      ? `Open ${providerNames[preferredAgent]} with WTS.md`
                      : `Open ${providerNames[preferredAgent]}`
                  }
                  className={styles.preferredChoice}
                  disabled={pending || briefBlocksAgents}
                  onClick={() => void openCli(preferredAgent)}
                  type="button"
                >
                  <span className={styles.providerMark}>
                    {providerMarks[preferredAgent]}
                  </span>
                  <span>
                    <b>
                      {state === "launching" &&
                      provider === preferredAgent
                        ? `Opening ${providerNames[preferredAgent]}…`
                        : `Open in ${providerNames[preferredAgent]}`}
                    </b>
                    <small>
                      {providerSetupLabel(preferredAgent, integrations)}
                    </small>
                  </span>
                </button>
              )}

              <button
                aria-label="Open workspace in VS Code"
                className={
                  preferredAgent
                    ? styles.editorChoice
                    : styles.preferredChoice
                }
                disabled={pending}
                onClick={() => void openVscode()}
                type="button"
              >
                <span className={styles.providerMark}>
                  {providerMarks.vscode}
                </span>
                <span>
                  <b>
                    {state === "openingVscode"
                      ? "Opening VS Code…"
                      : "Open in VS Code"}
                  </b>
                  <small>Existing multi-root workspace</small>
                </span>
              </button>
            </div>
          </section>

          <section
            aria-labelledby="other-agents-title"
            className={styles.section}
            data-ui="launcher.other-agents"
            data-ui-label="Other coding agents"
          >
            <div className={styles.sectionHeading}>
              <span>
                <small>ALTERNATIVES</small>
                <h3 id="other-agents-title">Other coding agents</h3>
              </span>
              <span className={styles.terminalPicker}>
                <span>Open agents in</span>
                <span aria-label="Terminal application" role="group">
                  {(["warp", "terminal"] as const).map((item) => (
                    <button
                      aria-pressed={terminal === item}
                      disabled={pending || (item === "warp" && !warpAvailable)}
                      key={item}
                      onClick={() => {
                        setTerminal(item);
                        setState("idle");
                        setMessage("");
                      }}
                      title={
                        item === "warp" && !warpAvailable
                          ? "Warp.app was not detected in Applications"
                          : undefined
                      }
                      type="button"
                    >
                      {terminalNames[item]}
                    </button>
                  ))}
                </span>
              </span>
            </div>

            <div className={styles.agentChoices}>
              {(["codex", "openCode", "hermes"] as const)
                .filter((item) => item !== preferredAgent)
                .map((item) => (
                  <button
                    aria-label={
                      preparedBrief
                        ? `Open ${providerNames[item]} with WTS.md`
                        : `Open ${providerNames[item]}`
                    }
                    disabled={pending || briefBlocksAgents}
                    key={item}
                    onClick={() => void openCli(item)}
                    type="button"
                  >
                    <span className={styles.providerMark}>
                      {providerMarks[item]}
                    </span>
                    <span>
                      <b>
                        {state === "launching" && provider === item
                          ? `Opening ${providerNames[item]}…`
                          : providerNames[item]}
                      </b>
                      <small>{providerSetupLabel(item, integrations)}</small>
                    </span>
                  </button>
                ))}
            </div>
          </section>

          {preparedBrief && (
            <section
              className={styles.brief}
              data-state={preparedBrief.state}
              data-ui="launcher.prepared-brief"
              data-ui-label="Prepared brief"
            >
              <span aria-hidden="true" className={styles.briefMark}>
                {preparedBrief.state === "ready"
                  ? "✓"
                  : preparedBrief.state === "error"
                    ? "!"
                    : "…"}
              </span>
              <div>
                <small>PREPARED BRIEF</small>
                <h3>
                  {preparedBrief.state === "ready"
                    ? "WTS.md is ready"
                    : preparedBrief.state === "error"
                      ? "WTS.md could not be saved"
                      : "Saving WTS.md…"}
                </h3>
                <p>
                  {preparedBrief.state === "ready"
                    ? `Agents opened here read the brief from ${preparedBrief.displayPath ?? "the workspace root"}.`
                    : preparedBrief.state === "error"
                      ? preparedBrief.error
                      : "The workspace-owned brief is being updated."}
                </p>
                <details>
                  <summary>Review prepared prompt</summary>
                  <pre aria-label="Prepared workspace brief">
                    {preparedBrief.prompt}
                  </pre>
                </details>
              </div>
              {preparedBrief.state === "error" && onRetryBrief && (
                <button
                  className={styles.retryButton}
                  disabled={pending}
                  onClick={onRetryBrief}
                  type="button"
                >
                  Save again
                </button>
              )}
            </section>
          )}

          {message && (
            <p
              aria-live={state === "error" ? "assertive" : "polite"}
              className={styles.message}
              data-error={state === "error" || undefined}
              role={state === "error" ? "alert" : "status"}
            >
              {message}
            </p>
          )}

          <details className={styles.details}>
            <summary>Launch details</summary>
            <dl>
              <div>
                <dt>Agent command</dt>
                <dd>
                  <code>{providerCommands[provider]}</code>
                </dd>
              </div>
              <div>
                <dt>Working directory</dt>
                <dd>{materialization.workspaceDisplayPath}</dd>
              </div>
            </dl>
          </details>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
