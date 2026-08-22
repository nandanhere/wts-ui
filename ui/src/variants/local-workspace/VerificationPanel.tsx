import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  VerificationCheckStatus,
  VerificationRunStatus,
  WorkspaceClient,
  WorkspaceEvidence,
  WorkspaceVerificationCheck,
  WorkspaceVerificationCheckResult,
} from "../../lib/wtsClient";
import {
  loadWorkspaceAutomation,
  saveWorkspaceAutomation,
} from "./workspaceAutomation";
import { sendDesktopNotification } from "./desktopNotifications";
import { loadTimeReviewSchedule } from "./timeReviewSchedule";
import { notificationForWorkspaceVerification } from "./workspaceNotifications";
import { VerificationFeedbackPanel } from "./VerificationFeedbackPanel";
import styles from "./VerificationPanel.module.css";

type DisplayStatus =
  | "notRun"
  | "running"
  | "passed"
  | "failed"
  | "cancelled"
  | "stale";

interface CheckView {
  plan: WorkspaceVerificationCheck;
  result: WorkspaceVerificationCheckResult | undefined;
}

function Icon({
  name,
}: {
  name:
    | "assistant"
    | "check"
    | "copy"
    | "error"
    | "graph"
    | "play"
    | "refresh"
    | "test";
}) {
  const paths = {
    assistant: (
      <>
        <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
        <path d="m6.3 6.3 2.1 2.1M15.6 15.6l2.1 2.1M17.7 6.3l-2.1 2.1M8.4 15.6l-2.1 2.1" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    copy: (
      <>
        <rect x="8" y="8" width="11" height="11" rx="2" />
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
      </>
    ),
    error: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6M12 17h.01" />
      </>
    ),
    graph: (
      <>
        <circle cx="6" cy="7" r="2.5" />
        <circle cx="18" cy="6" r="2.5" />
        <circle cx="12" cy="18" r="2.5" />
        <path d="m8.2 8.2 2.6 7.5M15.8 7.5l-2.6 8.2M8.5 6.8l7-.6" />
      </>
    ),
    play: <path d="m8 5 11 7-11 7V5Z" />,
    refresh: <path d="M20 7v5h-5M4 17v-5h5M18.5 10a7 7 0 0 0-12-3L4 10M5.5 14a7 7 0 0 0 12 3l2.5-3" />,
    test: (
      <>
        <path d="M9 3h6M10 3v5l-5 9a3 3 0 0 0 2.6 4h8.8a3 3 0 0 0 2.6-4l-5-9V3" />
        <path d="M8 15h8" />
      </>
    ),
  };

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <g
        fill="none"
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

function deriveStatus(
  evidence: WorkspaceEvidence,
  running: boolean,
): DisplayStatus {
  const resultStatus = evidence.verificationResult.status as string;
  if (running || resultStatus === "running") {
    return "running";
  }
  if (
    evidence.verificationResult.status !== "notRun" &&
    evidence.verificationResult.planRevision !==
      evidence.verificationPlan.revision
  ) {
    return "stale";
  }
  if (resultStatus === "passed") return "passed";
  if (resultStatus === "cancelled") return "cancelled";
  if (
    resultStatus === "failed" ||
    resultStatus === "blocked"
  ) {
    return "failed";
  }
  return "notRun";
}

function statusLabel(status: DisplayStatus) {
  return {
    notRun: "Not run",
    running: "Active",
    passed: "Passed",
    failed: "Failed",
    cancelled: "Cancelled",
    stale: "Stale",
  }[status];
}

function checkStatusLabel(status: VerificationCheckStatus | undefined) {
  if (!status) return "Not run";
  const labels: Record<string, string> = {
    pending: "Pending",
    running: "Active",
    passed: "Passed",
    failed: "Failed",
    timedOut: "Timed out",
    skipped: "Skipped",
    cancelled: "Cancelled",
  };
  return labels[status] ?? status;
}

function runStatusLabel(status: VerificationRunStatus) {
  const labels: Record<VerificationRunStatus, string> = {
    notRun: "Not run",
    running: "Active",
    passed: "Passed",
    failed: "Failed",
    blocked: "Blocked",
    cancelled: "Cancelled",
  };
  return labels[status];
}

function compactDuration(durationMs: number | null | undefined) {
  if (durationMs === null || durationMs === undefined) return "—";
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function lastRunLabel(timestamp: number | null) {
  if (timestamp === null) return "Never";
  return new Date(timestamp).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function failedResult(result: WorkspaceVerificationCheckResult) {
  return result.status === "failed" || result.status === "timedOut";
}

function promptField(value: string, maximum = 360) {
  const compact = value.replace(/[\r\n\t]+/g, " ").trim();
  return compact.length > maximum
    ? `${compact.slice(0, maximum - 1)}…`
    : compact;
}

function graphIndexLabel(status: WorkspaceEvidence["graphManifest"]["status"]) {
  if (status === "ready") return "Index available";
  if (status === "failed") return "Index failed";
  return "Not indexed";
}

const PLANNING_PROMPT_MAX_BYTES = 14 * 1024;
const AGENT_REPORT_REFRESH_INTERVAL_MS = 5_000;
const PLANNING_BOUNDARY =
  "Boundary: stay within the allowed repository worktrees. Do not modify verification plans, assertions, logs, graph output, or .wts files directly; publish findings through wts-report.";

interface CachedWorkspaceEvidence {
  evidence: WorkspaceEvidence;
  refreshedAt: number;
}

const evidenceCacheByClient = new WeakMap<
  WorkspaceClient,
  Map<string, CachedWorkspaceEvidence>
>();

function cachedWorkspaceEvidence(
  client: WorkspaceClient,
  workspaceId: string,
) {
  return evidenceCacheByClient.get(client)?.get(workspaceId) ?? null;
}

function cacheWorkspaceEvidence(
  client: WorkspaceClient,
  workspaceId: string,
  evidence: WorkspaceEvidence,
  refreshedAt: number,
) {
  let cache = evidenceCacheByClient.get(client);
  if (!cache) {
    cache = new Map();
    evidenceCacheByClient.set(client, cache);
  }
  cache.set(workspaceId, { evidence, refreshedAt });
}

function boundPlanningPrompt(prompt: string) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(prompt);
  if (bytes.length <= PLANNING_PROMPT_MAX_BYTES) return prompt;
  const suffix = `\n\n[Workspace context truncated to fit the bounded CLI task.]\n${PLANNING_BOUNDARY}`;
  const suffixBytes = encoder.encode(suffix);
  const prefixBytes = bytes.slice(
    0,
    Math.max(0, PLANNING_PROMPT_MAX_BYTES - suffixBytes.length),
  );
  const prefix = new TextDecoder()
    .decode(prefixBytes)
    .replace(/\uFFFD$/u, "");
  return `${prefix}${suffix}`;
}

/**
 * Builds a proposal-only CLI task from WTS-owned evidence.
 *
 * Workspace strings are compacted and bounded because they are context data,
 * not instructions. The provider must inspect the graph itself before naming
 * entry points or proposing checks.
 */
export function buildGraphVerificationPlanningPrompt(
  evidence: WorkspaceEvidence,
) {
  const graphReady = evidence.graphManifest.status === "ready";
  const lines = [
    "WTS graph-informed verification planning request",
    "",
    "Read WTS.md from the workspace root first. It is the durable WTS-owned agent guide; use the files it names as the trusted workspace and reporting boundary.",
    "",
    "This is a proposal-only task. Do not run project commands, modify repository files, install dependencies, or start services. You may publish findings only through the WTS report helper after completing the analysis.",
    "",
    "Required planning method:",
    "1. Read graphify-out/graph.json from the workspace root before proposing anything.",
    "2. Inventory every allowed repository. Classify each exactly once as reviewed, unresolved, or skipped with a concrete reason. Never silently omit a repository.",
    "3. Use graph communities, graph nodes, dependency relationships, repository manifests, lockfiles, tool-version files, devcontainer/Compose definitions, example configuration, and existing tests to identify the actual workspace-specific user-facing entry points. Also reconstruct the environment setup needed to make those entry points runnable. Reconstruct end-to-end user, service, and operational flows; do not substitute an endpoint list for a flow map.",
    "4. Do not assume WTS Help, WTS Preferences, or any other WTS application chrome belongs to this workspace.",
    "5. Propose checks tied to complete flows and existing repository test surfaces. Prefer existing scripts and the checks in `.wts/verification-plan.json`. Do not execute the proposal.",
    "6. Write the outcome to a temporary JSON file outside .wts, then run `wts-report --input <candidate.json>` from the workspace root. The helper validates the workspace boundary and atomically publishes .wts/agent-report.json. Preserve schemaVersion and workspaceId, set updatedAtUnixMs to the current Unix time in milliseconds, and include summary, scope, environment, flows, findings, nextActions, proposedChecks, and validationFlows. Do not edit .wts directly or write a transcript.",
    `7. Copy graphSha256 exactly from .wts/graph-manifest.json when graphStatus is ready, including its sha256: prefix. Current graphStatus=${evidence.graphManifest.status}${evidence.graphManifest.graphSha256 ? ` and graphSha256=${evidence.graphManifest.graphSha256}` : ""}.`,
    "8. Report secret names only—never values. Each flows item must contain id, title, kind, actors, entryPoints, steps, expectedOutcome, risks, existingCoverage, and verificationCandidateIds.",
    "",
    "Current workspace identity:",
    `Workspace ID: ${promptField(evidence.context.workspaceId)}`,
    `Graph index: ${graphIndexLabel(evidence.graphManifest.status)}. ${
      graphReady
        ? "An index exists, but WTS has not asserted that it is fresh for the current working tree."
        : "A usable index is not available; stop and ask for a build or re-index before making graph-informed claims."
    }`,
    "",
    PLANNING_BOUNDARY,
  ];
  return boundPlanningPrompt(lines.join("\n"));
}

function AgentReportCard({
  evidence,
  refreshing,
  lastRefreshedAt,
  promotingId,
  onRefresh,
  onPromote,
}: {
  evidence: WorkspaceEvidence;
  refreshing: boolean;
  lastRefreshedAt: number | null;
  promotingId: string | null;
  onRefresh: () => void;
  onPromote: (proposalId: string) => void;
}) {
  const report = evidence.agentReport;
  const repositoryLabels = new Map(
    evidence.context.repositories.map((repository) => [
      repository.repositoryId,
      repository.label,
    ]),
  );
  const ready = report.status === "ready";
  const hasStructuredFlows = report.flows.length > 0;
  const legacyFlows = report.validationFlows;
  const scope = report.scope;
  const environment = report.environment;
  const totalRepositories = evidence.context.repositories.length;
  const reviewedCount = scope.reviewedRepositoryIds.length;
  const accountedCount =
    reviewedCount +
    scope.unresolvedRepositoryIds.length +
    scope.skippedRepositories.length;
  const graphFresh =
    scope.graphStatus === "ready" &&
    Boolean(scope.graphSha256) &&
    scope.graphSha256 === evidence.graphManifest.graphSha256;
  const graphCoverageLabel =
    scope.coverage === "unassessed"
      ? "Freshness not reported"
      : scope.graphStatus === "notStarted"
        ? "Not indexed"
        : scope.graphStatus === "failed"
          ? "Index failed"
          : graphFresh
            ? "Current snapshot"
            : "Snapshot changed";
  const unattachedFindings = report.findings.filter(
    (finding) => !finding.flowIds || finding.flowIds.length === 0,
  );
  const title =
    report.status === "invalid"
      ? "Agent report needs attention"
      : ready
        ? "Supporting evidence"
        : "No agent findings yet";

  return (
    <section
      aria-busy={refreshing}
      aria-labelledby="agent-report-title"
      className={styles.agentReport}
      data-ui="verification.agent-report"
      data-ui-label="Verification agent report"
      data-status={report.status}
    >
      <header>
        <span>
          <small>AGENT-REPORTED · NOT VERIFIED</small>
          <h3 id="agent-report-title">{title}</h3>
        </span>
        <span className={styles.agentReportMeta}>
          <span
            aria-live="polite"
            className={styles.liveStatus}
            data-state={refreshing ? "refreshing" : "live"}
            role="status"
          >
            <i aria-hidden="true" />
            {refreshing
              ? "Live · checking…"
              : lastRefreshedAt === null
                ? "Live updates on"
                : `Live · checked ${new Date(lastRefreshedAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                    second: "2-digit",
                  })}`}
          </span>
          <button
            aria-label="Refresh findings"
            className={styles.agentRefreshButton}
            disabled={refreshing}
            onClick={onRefresh}
            title="Refresh findings"
            type="button"
          >
            <Icon name="refresh" />
          </button>
        </span>
      </header>

      {ready ? (
        <>
          <div className={styles.flowReportIntro}>
            <p>{report.summary || "The agent did not provide a summary."}</p>
            <dl aria-label="Workspace analysis coverage">
              <div>
                <dt>Coverage</dt>
                <dd data-coverage={scope.coverage}>
                  {scope.coverage === "unassessed"
                    ? "Not reported"
                    : `${scope.coverage} · ${reviewedCount}/${totalRepositories} reviewed`}
                </dd>
              </div>
              <div>
                <dt>Accounted for</dt>
                <dd>
                  {scope.coverage === "unassessed"
                    ? "Unknown"
                    : `${accountedCount}/${totalRepositories} repositories`}
                </dd>
              </div>
              <div>
                <dt>Unresolved</dt>
                <dd>{scope.unresolvedRepositoryIds.length}</dd>
              </div>
              <div>
                <dt>Graph</dt>
                <dd data-fresh={graphFresh}>
                  {graphCoverageLabel}
                </dd>
              </div>
            </dl>
          </div>

          <div className={styles.evidenceSections}>
          <details className={styles.evidenceSection} data-section="behavior">
            <summary>
              <span>System behavior (agent-reported)</span>
              <small>{hasStructuredFlows ? report.flows.length : legacyFlows.length}</small>
            </summary>
            <div className={styles.reportView}>
            {hasStructuredFlows ? (
              <div className={styles.flowList}>
                {report.flows.map((flow) => {
                  const flowRepositoryIds = new Set(
                    flow.steps.map((step) => step.repositoryId),
                  );
                  const relatedFindings = report.findings.filter(
                    (finding) => finding.flowIds?.includes(flow.id) ?? false,
                  );
                  return (
                    <details key={flow.id} open={report.flows.length === 1}>
                      <summary>
                        <span>
                          <small>{flow.kind} behavior</small>
                          <b>{flow.title}</b>
                        </span>
                        <span>
                          {flow.steps.length} steps ·{" "}
                          {flowRepositoryIds.size}{" "}
                          {flowRepositoryIds.size === 1 ? "repo" : "repos"}
                        </span>
                      </summary>
                      <div className={styles.flowBody}>
                        <div className={styles.flowContext}>
                          <span>
                            <b>Actors</b>
                            {flow.actors.join(", ") || "Not identified"}
                          </span>
                          <span>
                            <b>Entry points</b>
                            {flow.entryPoints.join(", ") || "Not identified"}
                          </span>
                          <span>
                            <b>Expected outcome</b>
                            {flow.expectedOutcome}
                          </span>
                        </div>
                        <ol className={styles.flowSteps}>
                          {flow.steps.map((step) => (
                            <li key={step.id}>
                              <span aria-hidden="true" />
                              <div>
                                <small>
                                  {repositoryLabels.get(step.repositoryId) ??
                                    step.repositoryId}{" "}
                                  · {step.component}
                                </small>
                                <b>{step.action}</b>
                                {step.evidence.length > 0 && (
                                  <ul aria-label={`${step.action} evidence`}>
                                    {step.evidence.map((item) => (
                                      <li
                                        key={`${item.repositoryId}:${item.path}:${item.line ?? ""}`}
                                      >
                                        <code>
                                          {item.path}
                                          {item.line ? `:${item.line}` : ""}
                                        </code>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            </li>
                          ))}
                        </ol>
                        {(flow.risks.length > 0 || relatedFindings.length > 0) && (
                          <div className={styles.flowNotes}>
                            <b>Risks and findings</b>
                            <ul>
                              {flow.risks.map((risk) => (
                                <li key={risk}>{risk}</li>
                              ))}
                              {relatedFindings.map((finding) => (
                                <li key={finding.id}>{finding.title}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    </details>
                  );
                })}
              </div>
            ) : legacyFlows.length > 0 ? (
              <section className={styles.agentFlows}>
                <header>
                  <span>
                    <small>LEGACY REPORT · REVIEW-ONLY</small>
                    <b>System behavior</b>
                  </span>
                  <small>Coverage was not recorded by this report</small>
                </header>
                {legacyFlows.map((flow) => (
                  <details key={flow.id}>
                    <summary>
                      <span>
                        <b>{flow.title}</b>
                        <small>{flow.goal}</small>
                      </span>
                      <span aria-hidden="true">›</span>
                    </summary>
                    <div>
                      {flow.prerequisites.length > 0 && (
                        <>
                          <b>Prerequisites</b>
                          <ul>
                            {flow.prerequisites.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        </>
                      )}
                      <ol>
                        {flow.steps.map((step) => (
                          <li key={step.id}>
                            <b>{step.action}</b>
                            <span>Expected: {step.expected}</span>
                            {step.evidence.length > 0 && (
                              <code>{step.evidence.join(" · ")}</code>
                            )}
                          </li>
                        ))}
                      </ol>
                    </div>
                  </details>
                ))}
              </section>
            ) : (
              <p className={styles.reportEmpty}>
                No end-to-end behavior was mapped. Refresh the analysis before
                treating these findings as workspace coverage.
              </p>
            )}
            </div>
          </details>

          <details className={styles.evidenceSection} data-section="environment">
            <summary>
              <span>Environment</span>
              <small>{environment.requirements.length + environment.setupSteps.length}</small>
            </summary>
            <div className={styles.reportView}>
            {environment.status === "unassessed" ? (
              <p className={styles.reportEmpty}>
                Environment setup was not assessed by this report. Re-run the
                Graphify planning brief to map toolchains, configuration,
                secrets, services, and bootstrap steps.
              </p>
            ) : (
              <div className={styles.environmentPlan}>
                <header>
                  <span>
                    <small>GRAPH-INFORMED · REVIEW BEFORE RUNNING</small>
                    <b>Environment setup</b>
                    <p>{environment.summary}</p>
                  </span>
                  <span data-status={environment.status}>
                    {environment.status === "planned"
                      ? "Plan ready"
                      : environment.status === "needsInput"
                        ? "Needs input"
                        : "Blocked"}
                  </span>
                </header>

                <div className={styles.environmentMetrics}>
                  {(
                    [
                      ["toolchain", "Toolchains"],
                      ["configuration", "Configuration"],
                      ["secret", "Secret names"],
                      ["service", "Services"],
                    ] as const
                  ).map(([kind, label]) => (
                    <span key={kind}>
                      <b>
                        {
                          environment.requirements.filter(
                            (requirement) => requirement.kind === kind,
                          ).length
                        }
                      </b>
                      <small>{label}</small>
                    </span>
                  ))}
                </div>

                {environment.requirements.length > 0 && (
                  <ul
                    aria-label="Environment requirements"
                    className={styles.environmentRequirements}
                  >
                    {environment.requirements.map((requirement) => (
                      <li key={requirement.id}>
                        <span data-kind={requirement.kind}>
                          {requirement.kind}
                        </span>
                        <div>
                          <b>{requirement.name}</b>
                          <small>
                            {repositoryLabels.get(requirement.repositoryId) ??
                              requirement.repositoryId}
                            {" · "}
                            {requirement.required ? "required" : "optional"}
                            {" · "}
                            {requirement.source}
                          </small>
                          <p>{requirement.detail}</p>
                          <code>
                            {requirement.evidence
                              .map((item) => item.path)
                              .join(" · ")}
                          </code>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {environment.setupSteps.length > 0 && (
                  <section className={styles.environmentSteps}>
                    <header>
                      <b>Proposed setup sequence</b>
                      <small>Copy or run manually after review</small>
                    </header>
                    <ol>
                      {environment.setupSteps.map((step) => (
                        <li key={step.id}>
                          <span aria-hidden="true" />
                          <div>
                            <small>
                              {repositoryLabels.get(step.repositoryId) ??
                                step.repositoryId}
                            </small>
                            <b>{step.action}</b>
                            <code>{step.command.join(" ")}</code>
                            <small title={step.workingDirectory}>
                              in {step.workingDirectory}
                            </small>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}

                {environment.unresolved.length > 0 && (
                  <section className={styles.environmentUnresolved}>
                    <b>Needs a decision</b>
                    <ul>
                      {environment.unresolved.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            )}
            </div>
          </details>

          <details className={styles.evidenceSection} data-section="suggestions">
            <summary>
              <span>Suggested checks</span>
              <small>{report.proposedChecks.length}</small>
            </summary>
            <div className={styles.reportView}>
            <div className={styles.repositoryCoverage}>
              <header>
                <b>Repository accounting</b>
                <span>{accountedCount} of {totalRepositories}</span>
              </header>
              <ul>
                {evidence.context.repositories.map((repository) => {
                  const skipped = scope.skippedRepositories.find(
                    (item) => item.repositoryId === repository.repositoryId,
                  );
                  const state = scope.reviewedRepositoryIds.includes(
                    repository.repositoryId,
                  )
                    ? "reviewed"
                    : scope.unresolvedRepositoryIds.includes(
                          repository.repositoryId,
                        )
                      ? "unresolved"
                      : skipped
                        ? "skipped"
                        : "not accounted";
                  return (
                    <li key={repository.repositoryId}>
                      <b>{repository.label}</b>
                      <span data-state={state}>{state}</span>
                      {skipped && <small>{skipped.reason}</small>}
                    </li>
                  );
                })}
              </ul>
            </div>
            {report.proposedChecks.length > 0 ? (
              <section className={styles.agentProposals}>
                <header>
                  <span>
                    <small>REVIEW BEFORE RUNNING</small>
                    <b>Proposed checks</b>
                  </span>
                  <small>{report.proposedChecks.length} candidates</small>
                </header>
                <ul>
                  {report.proposedChecks.map((proposal) => {
                    const promoted = evidence.verificationPlan.checks.some(
                      (check) => check.id === `agent-${proposal.id}`,
                    );
                    const promoting = promotingId === proposal.id;
                    return (
                      <li key={proposal.id}>
                        <div className={styles.agentProposalIdentity}>
                          <span>
                            <b>{proposal.label}</b>
                            <small>
                              {repositoryLabels.get(proposal.repositoryId) ??
                                proposal.repositoryId}
                            </small>
                          </span>
                          <code>
                            {[proposal.executable, ...proposal.args].join(" ")}
                          </code>
                          <p>{proposal.reason}</p>
                        </div>
                        <button
                          className={styles.proposalButton}
                          disabled={promoted || promoting}
                          onClick={() => onPromote(proposal.id)}
                          type="button"
                        >
                          <Icon name={promoted ? "check" : "test"} />
                          {promoted
                            ? "Added to plan"
                            : promoting
                              ? "Adding…"
                              : "Add to verification"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : (
              <p className={styles.reportEmpty}>
                No runnable checks were proposed by this analysis.
              </p>
            )}
            </div>
          </details>

          <details className={styles.evidenceSection} data-section="findings" open>
            <summary>
              <span>Findings and next actions</span>
              <small>{report.findings.length}</small>
            </summary>
            <div className={styles.reportView}>
            {unattachedFindings.length > 0 ? (
              <ul className={styles.agentFindings}>
                {unattachedFindings.map((finding) => (
                  <li data-severity={finding.severity} key={finding.id}>
                    <span aria-hidden="true" />
                    <div>
                      <header>
                        <b>{finding.title}</b>
                        <small>
                          {finding.severity}
                          {finding.repositoryId
                            ? ` · ${repositoryLabels.get(finding.repositoryId) ?? finding.repositoryId}`
                            : ""}
                        </small>
                      </header>
                      {finding.detail && <p>{finding.detail}</p>}
                      {finding.evidence.length > 0 && (
                        <ul aria-label={`${finding.title} evidence`}>
                          {finding.evidence.map((item) => (
                            <li key={item}><code>{item}</code></li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.reportEmpty}>
                No unattached findings were reported. Behavior-specific
                findings appear with the related system behavior.
              </p>
            )}
            {report.nextActions.length > 0 && (
              <div className={styles.agentNextActions}>
                <b>Suggested next actions</b>
                <ul>
                  {report.nextActions.map((action) => (
                    <li key={action}>{action}</li>
                  ))}
                </ul>
              </div>
            )}
            </div>
          </details>

          <details className={styles.evidenceSection} data-section="agent-history">
            <summary>
              <span>Agent analysis history</span>
              <small>{evidence.agentRuns.length}</small>
            </summary>
            <div className={styles.reportView}>
            <div className={styles.reportRuns}>
              <span>
                <small>Trusted verification</small>
                <b>{runStatusLabel(evidence.verificationResult.status)}</b>
                <em>{lastRunLabel(evidence.verificationResult.completedAtUnixMs)}</em>
              </span>
              <span>
                <small>Agent analyses</small>
                <b>{evidence.agentRuns.length}</b>
                <em>Not independently verified</em>
              </span>
            </div>
            </div>
          </details>
          </div>
        </>
      ) : report.status === "invalid" ? (
        <div className={styles.agentReportProblem} role="alert">
          <span aria-hidden="true">
            <Icon name="error" />
          </span>
          <div>
            <b>WTS could not use this report.</b>
            <p>{report.detail}</p>
            <small>
              Fix <code>{report.displayPath}</code>, save valid report JSON, then
              refresh. WTS keeps the last verification result unchanged.
            </small>
          </div>
        </div>
      ) : (
        <p className={styles.agentReportEmpty}>
          {report.detail}{" "}
          {report.status === "notReported" && (
            <>
              The prepared prompt tells the agent to publish a concise report
              to <code>{report.displayPath}</code>.
            </>
          )}
        </p>
      )}
    </section>
  );
}

function contextForAgent(
  evidence: WorkspaceEvidence,
  status: DisplayStatus,
) {
  const resultById = new Map(
    evidence.verificationResult.checks.map((check) => [check.checkId, check]),
  );
  const failed = evidence.verificationPlan.checks
    .map((check) => ({ check, result: resultById.get(check.id) }))
    .filter(
      (
        item,
      ): item is {
        check: WorkspaceVerificationCheck;
        result: WorkspaceVerificationCheckResult;
      } => Boolean(item.result && failedResult(item.result)),
    );
  const repositories = evidence.context.repositories
    .map(
      (repository) =>
        `${repository.label} @ ${repository.baseCommitOid.slice(0, 8)}`,
    )
    .join(", ");
  const lines = [
    `WTS workspace: ${evidence.context.title}`,
    `Workspace ID: ${evidence.context.workspaceId}`,
    `Branch: ${evidence.context.branchName}`,
    `Allowed repositories: ${repositories || "None"}`,
    `Verification: ${statusLabel(status)} (${evidence.verificationResult.checks.filter((check) => check.status === "passed").length}/${evidence.verificationPlan.checks.length} passed)`,
    `Graph index: ${graphIndexLabel(evidence.graphManifest.status)} — freshness is not asserted by WTS`,
    `Graph detail: ${evidence.graphManifest.detail}`,
  ];
  if (failed.length) {
    lines.push("Failed checks:");
    for (const { check, result } of failed) {
      lines.push(
        `- ${check.label}: ${result.detail || checkStatusLabel(result.status)}${result.logDisplayPath ? ` (log: ${result.logDisplayPath})` : ""}`,
      );
    }
  }
  if (evidence.verificationResult.warnings.length) {
    lines.push(
      `Warnings: ${evidence.verificationResult.warnings.join("; ")}`,
    );
  }
  lines.push(`Evidence: ${evidence.context.evidenceDisplayPath}`);
  lines.push(
    "Boundary: modify only the allowed repositories above; do not modify acceptance evidence.",
  );
  return lines.join("\n");
}

function CheckRow({
  item,
  active,
  running,
  onRun,
}: {
  item: CheckView;
  active: boolean;
  running: boolean;
  onRun?: (checkId: string, label: string) => void;
}) {
  const { plan, result } = item;
  const status = result?.status;
  const command = [plan.executable, ...plan.args].join(" ");
  return (
    <details
      className={styles.check}
      data-action={onRun ? "available" : "unavailable"}
      data-status={status ?? "notRun"}
    >
      <summary>
        <span className={styles.checkState} aria-hidden="true">
          {status === "passed" ? (
            <Icon name="check" />
          ) : status === "running" ? (
            <i />
          ) : status === "failed" || status === "timedOut" ? (
            <Icon name="error" />
          ) : (
            <span />
          )}
        </span>
        <span className={styles.checkIdentity}>
          <b>{plan.label}</b>
          <small>
            {plan.kind}
            {!plan.required && " · advisory"}
          </small>
        </span>
        <span className={styles.checkResult}>
          <b>{checkStatusLabel(status)}</b>
          <small>{compactDuration(result?.durationMs)}</small>
        </span>
        {onRun && (
          <button
            className={styles.checkRunButton}
            disabled={running}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onRun(plan.id, plan.label);
            }}
            type="button"
          >
            {active ? <i /> : <Icon name={status ? "refresh" : "play"} />}
            {active ? "Run in progress" : status ? "Run again" : "Run"}
          </button>
        )}
        <span className={styles.disclosure} aria-hidden="true">
          ›
        </span>
      </summary>
      <div className={styles.checkDetails}>
        <dl>
          <div>
            <dt>Command</dt>
            <dd>
              <code>{command}</code>
            </dd>
          </div>
          <div>
            <dt>Working directory</dt>
            <dd>
              <code>{plan.workingDirectory}</code>
            </dd>
          </div>
          <div>
            <dt>Exit</dt>
            <dd>{result?.exitCode ?? "Not available"}</dd>
          </div>
          <div>
            <dt>Limit</dt>
            <dd>{compactDuration(plan.timeoutMs)}</dd>
          </div>
        </dl>
        {result?.detail && (
          <pre aria-label={`${plan.label} result detail`}>{result.detail}</pre>
        )}
        {result?.logDisplayPath && (
          <p className={styles.logPath}>
            Bounded log <code>{result.logDisplayPath}</code>
          </p>
        )}
        {plan.acceptanceFiles.length > 0 && (
          <p className={styles.acceptance}>
            <Icon name="check" />
            {plan.acceptanceFiles.length} acceptance{" "}
            {plan.acceptanceFiles.length === 1 ? "file" : "files"} pinned
          </p>
        )}
      </div>
    </details>
  );
}

function VerificationHistory({ evidence }: { evidence: WorkspaceEvidence }) {
  const history = evidence.verificationHistory ?? [];
  return (
    <details
      className={styles.runHistory}
      data-ui="verification.run-history"
      data-ui-label="Verification run history"
    >
      <summary>
        Recent verification runs
        <span>{history.length}</span>
      </summary>
      <ol>
        {history.slice(0, 10).map((run, index) => (
          <li key={`${run.startedAtUnixMs ?? "run"}-${index}`}>
            <b data-status={run.status}>{runStatusLabel(run.status)}</b>
            <span>
              {lastRunLabel(run.completedAtUnixMs ?? run.startedAtUnixMs)}
            </span>
            <small>{compactDuration(run.durationMs)}</small>
          </li>
        ))}
      </ol>
    </details>
  );
}

export function VerificationPanel({
  client,
  materialized,
  workspaceId,
  workspaceKey,
  onNotice,
  onIndexGraph,
  onPrepareCliTask,
  onVerificationFailed,
}: {
  client: WorkspaceClient;
  materialized: boolean;
  workspaceId: string;
  workspaceKey: string;
  onNotice: (message: string) => void;
  onIndexGraph?: () => Promise<unknown>;
  onPrepareCliTask?: (prompt: string) => void;
  onVerificationFailed?: () => void;
}) {
  const initialCachedEvidence = materialized
    ? cachedWorkspaceEvidence(client, workspaceId)
    : null;
  const [evidence, setEvidence] = useState<WorkspaceEvidence | null>(
    initialCachedEvidence?.evidence ?? null,
  );
  const [state, setState] = useState<"loading" | "ready" | "running" | "error">(
    materialized && !initialCachedEvidence ? "loading" : "ready",
  );
  const [buildingGraph, setBuildingGraph] = useState(false);
  const [promotingProposalId, setPromotingProposalId] = useState<string | null>(
    null,
  );
  const [evidenceRefreshing, setEvidenceRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(
    initialCachedEvidence?.refreshedAt ?? null,
  );
  const [activeOperation, setActiveOperation] = useState<
    "all" | "failed" | "cancel" | string | null
  >(null);
  const [error, setError] = useState("");
  const [errorAction, setErrorAction] = useState<
    "load" | "run" | "graph" | null
  >(null);
  const [automation, setAutomation] = useState(loadWorkspaceAutomation);
  const generation = useRef(0);
  const evidenceRequest = useRef<Promise<boolean> | null>(null);
  const retryVerification = useRef<(() => void) | null>(null);
  const busy = useRef(false);
  const verificationRunning = useRef(false);
  const operationalClient = client;

  busy.current =
    state === "running" || buildingGraph || promotingProposalId !== null;
  verificationRunning.current = state === "running";

  const load = useCallback((background = false): Promise<boolean> => {
    if (evidenceRequest.current) {
      return evidenceRequest.current;
    }
    const requestGeneration = background
      ? generation.current
      : ++generation.current;
    if (!background) {
      setState("loading");
    }
    setEvidenceRefreshing(true);
    setError("");
    setErrorAction(null);
    let request!: Promise<boolean>;
    request = (async () => {
      try {
        const next = await client.getWorkspaceEvidence(workspaceId);
        if (requestGeneration !== generation.current) return false;
        const refreshedAt = Date.now();
        if (next) {
          cacheWorkspaceEvidence(client, workspaceId, next, refreshedAt);
        } else {
          evidenceCacheByClient.get(client)?.delete(workspaceId);
        }
        setEvidence(next);
        setLastRefreshedAt(refreshedAt);
        setState((current) => current === "running" ? current : "ready");
        return true;
      } catch (reason) {
        if (requestGeneration !== generation.current) return false;
        setError(
          reason instanceof Error
            ? reason.message
            : "Workspace evidence could not be read.",
        );
        setErrorAction("load");
        setState((current) =>
          current === "running" ? current : background ? "ready" : "error",
        );
        return false;
      } finally {
        if (evidenceRequest.current === request) {
          evidenceRequest.current = null;
        }
        if (requestGeneration === generation.current) {
          setEvidenceRefreshing(false);
        }
      }
    })();
    evidenceRequest.current = request;
    return request;
  }, [client, workspaceId]);

  useEffect(() => {
    generation.current += 1;
    evidenceRequest.current = null;
    const cached = materialized
      ? cachedWorkspaceEvidence(client, workspaceId)
      : null;
    setEvidence(cached?.evidence ?? null);
    setError("");
    setErrorAction(null);
    setBuildingGraph(false);
    setPromotingProposalId(null);
    setEvidenceRefreshing(false);
    setLastRefreshedAt(cached?.refreshedAt ?? null);
    setActiveOperation(null);
    if (!materialized) {
      setState("ready");
      return;
    }
    setState(cached ? "ready" : "loading");
    void load(Boolean(cached));
    return () => {
      generation.current += 1;
    };
    // load is intentionally scoped to the selected workspace identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, materialized, workspaceId]);

  useEffect(() => {
    if (!materialized) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const schedule = () => {
      clearTimer();
      if (cancelled || document.visibilityState === "hidden") return;
      timer = setTimeout(() => {
        timer = null;
        void (async () => {
          if (
            !cancelled &&
            document.visibilityState !== "hidden" &&
            (!busy.current || verificationRunning.current)
          ) {
            await load(true);
          }
          schedule();
        })();
      }, AGENT_REPORT_REFRESH_INTERVAL_MS);
    };
    const handleVisibility = () => {
      clearTimer();
      if (document.visibilityState === "hidden") return;
      void (async () => {
        if (!busy.current || verificationRunning.current) {
          await load(true);
        }
        schedule();
      })();
    };

    document.addEventListener("visibilitychange", handleVisibility);
    schedule();
    return () => {
      cancelled = true;
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [load, materialized]);

  const displayStatus = evidence
    ? deriveStatus(evidence, state === "running")
    : "notRun";
  const resultById = useMemo(
    () =>
      new Map(
        evidence?.verificationResult.checks.map((check) => [
          check.checkId,
          check,
        ]) ?? [],
      ),
    [evidence],
  );
  const groups = useMemo(() => {
    if (!evidence) return [];
    const labels = new Map(
      evidence.context.repositories.map((repository) => [
        repository.repositoryId,
        repository.label,
      ]),
    );
    const grouped = new Map<string, CheckView[]>();
    for (const check of evidence.verificationPlan.checks) {
      const label = check.repositoryId
        ? labels.get(check.repositoryId) ?? "Unknown repository"
        : "Workspace";
      const current = grouped.get(label) ?? [];
      current.push({ plan: check, result: resultById.get(check.id) });
      grouped.set(label, current);
    }
    return [...grouped.entries()];
  }, [evidence, resultById]);
  const total = evidence?.verificationPlan.checks.length ?? 0;
  const passed =
    evidence?.verificationResult.checks.filter(
      (check) => check.status === "passed",
    ).length ?? 0;
  const failedChecks =
    evidence?.verificationResult.checks.filter(failedResult) ?? [];
  const firstFailure = failedChecks[0];
  const firstFailurePlan = evidence?.verificationPlan.checks.find(
    (check) => check.id === firstFailure?.checkId,
  );
  const hasPlan = total > 0;

  const performVerification = async (
    operation: string,
    startNotice: string,
    failureNotice: string,
    request: () => Promise<WorkspaceEvidence>,
  ): Promise<void> => {
    if (!evidence || !hasPlan || state === "running") return;
    const requestGeneration = generation.current;
    retryVerification.current = () => {
      void performVerification(
        operation,
        startNotice,
        failureNotice,
        request,
      );
    };
    setActiveOperation(operation);
    setState("running");
    setError("");
    setErrorAction(null);
    onNotice(`${workspaceKey} · ${startNotice}`);
    try {
      const next = await request();
      if (requestGeneration !== generation.current) return;
      // A live-progress read can still be in flight when the run completes.
      // Invalidate that read before the completed result becomes authoritative.
      generation.current += 1;
      evidenceRequest.current = null;
      const refreshedAt = Date.now();
      cacheWorkspaceEvidence(client, workspaceId, next, refreshedAt);
      setEvidence(next);
      setLastRefreshedAt(refreshedAt);
      setState("ready");
      setActiveOperation(null);
      const nextStatus = deriveStatus(next, false);
      onNotice(`${workspaceKey} · verification ${statusLabel(nextStatus).toLowerCase()}`);
      const notification = notificationForWorkspaceVerification(
        workspaceKey,
        next,
      );
      if (notification) onVerificationFailed?.();
      if (notification && loadTimeReviewSchedule().notificationsEnabled) {
        void sendDesktopNotification(
          notification.title,
          notification.body,
          `wts-verification-${workspaceId}`,
        );
      }
    } catch (reason) {
      if (requestGeneration !== generation.current) return;
      setError(
        reason instanceof Error
          ? reason.message
          : "Verification could not be completed.",
      );
      setErrorAction("run");
      setState("error");
      setActiveOperation(null);
      onNotice(`${workspaceKey} · ${failureNotice}`);
    }
  };

  const run = () =>
    performVerification(
      "all",
      "running all verification checks…",
      "verification could not run",
      () => client.runWorkspaceVerification(workspaceId),
    );

  const runCheck = (checkId: string, label: string) => {
    if (!operationalClient.runWorkspaceVerificationCheck) return;
    return performVerification(
      `check:${checkId}`,
      `running ${label}…`,
      `${label} could not run`,
      () =>
        operationalClient.runWorkspaceVerificationCheck!(
          workspaceId,
          checkId,
        ),
    );
  };

  const rerunFailed = () => {
    if (!operationalClient.rerunFailedWorkspaceVerification) return;
    return performVerification(
      "failed",
      "rerunning failed checks…",
      "failed checks could not rerun",
      () => operationalClient.rerunFailedWorkspaceVerification!(workspaceId),
    );
  };

  const cancelRun = async () => {
    if (
      state !== "running" ||
      !operationalClient.cancelWorkspaceVerification
    ) {
      return;
    }
    const requestGeneration = ++generation.current;
    setActiveOperation("cancel");
    onNotice(`${workspaceKey} · cancelling verification…`);
    try {
      const next =
        await operationalClient.cancelWorkspaceVerification(workspaceId);
      if (requestGeneration !== generation.current) return;
      const refreshedAt = Date.now();
      cacheWorkspaceEvidence(client, workspaceId, next, refreshedAt);
      setEvidence(next);
      setLastRefreshedAt(refreshedAt);
      setState("ready");
      setActiveOperation(null);
      onNotice(`${workspaceKey} · verification cancelled`);
    } catch (reason) {
      if (requestGeneration !== generation.current) return;
      setError(
        reason instanceof Error
          ? reason.message
          : "Verification could not be cancelled.",
      );
      setErrorAction(null);
      setState("error");
      setActiveOperation(null);
      onNotice(`${workspaceKey} · verification could not be cancelled`);
    }
  };

  const copyContext = async () => {
    if (!evidence) return;
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable.");
      }
      await navigator.clipboard.writeText(
        contextForAgent(evidence, displayStatus),
      );
      onNotice(`${workspaceKey} · verification context copied for an agent`);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Context could not be copied.",
      );
      setErrorAction(null);
    }
  };

  const prepareCliTask = () => {
    if (!evidence || !onPrepareCliTask) return;
    onPrepareCliTask(buildGraphVerificationPlanningPrompt(evidence));
    onNotice(
      `${workspaceKey} · graph-informed task prepared for the workspace CLI`,
    );
  };

  const buildGraph = async () => {
    if (!onIndexGraph || buildingGraph) return;
    setBuildingGraph(true);
    setError("");
    setErrorAction(null);
    onNotice(`${workspaceKey} · building workspace graph…`);
    try {
      await onIndexGraph();
      const refreshed = await load();
      if (refreshed) {
        onNotice(`${workspaceKey} · workspace graph ready`);
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The workspace graph could not be built.",
      );
      setErrorAction("graph");
      onNotice(`${workspaceKey} · workspace graph could not be built`);
    } finally {
      setBuildingGraph(false);
    }
  };

  const refreshAgentReport = async () => {
    const refreshed = await load();
    if (refreshed) {
      onNotice(`${workspaceKey} · agent findings refreshed`);
    }
  };

  const promoteAgentCheck = async (proposalId: string) => {
    if (promotingProposalId) return;
    setPromotingProposalId(proposalId);
    setError("");
    setErrorAction(null);
    onNotice(`${workspaceKey} · adding reviewed check to verification…`);
    try {
      const next = await client.promoteAgentVerificationCheck(
        workspaceId,
        proposalId,
      );
      const refreshedAt = Date.now();
      cacheWorkspaceEvidence(client, workspaceId, next, refreshedAt);
      setEvidence(next);
      setLastRefreshedAt(refreshedAt);
      setState("ready");
      onNotice(`${workspaceKey} · reviewed check added; ready to run`);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The proposed check could not be added.",
      );
      setErrorAction(null);
      onNotice(`${workspaceKey} · proposed check could not be added`);
    } finally {
      setPromotingProposalId(null);
    }
  };

  const retryErrorAction = () => {
    if (errorAction === "load") {
      void load();
    } else if (errorAction === "run") {
      retryVerification.current?.();
    } else if (errorAction === "graph") {
      void buildGraph();
    } else {
      setError("");
    }
  };

  if (!materialized) {
    return (
      <section
        className={styles.empty}
        aria-labelledby="verification-empty-title"
        data-ui="verification.setup"
        data-ui-label="Verification setup"
      >
        <span className={styles.emptyIcon}>
          <Icon name="test" />
        </span>
        <small>VERIFICATION</small>
        <h2 id="verification-empty-title">Create the workspace first</h2>
        <p>
          Verification uses a fixed allowlist of checks discovered from local
          repository manifests and stores evidence beside the isolated
          worktrees. This draft has no runnable workspace yet.
        </p>
      </section>
    );
  }

  if (state === "loading" && !evidence) {
    return (
      <section
        className={styles.loading}
        role="status"
        aria-label="Loading verification"
        data-ui="verification.loading"
        data-ui-label="Verification loading state"
      >
        <span className={styles.loadingMark}>
          <Icon name="test" />
        </span>
        <span>
          <b>Reading workspace evidence</b>
          <small>Loading the local verification plan and latest result…</small>
        </span>
      </section>
    );
  }

  if (state === "error" && !evidence) {
    return (
      <section
        className={styles.empty}
        role="alert"
        data-ui="verification.load-error"
        data-ui-label="Verification load error"
      >
        <span className={styles.emptyIcon} data-error>
          <Icon name="error" />
        </span>
        <small>VERIFICATION UNAVAILABLE</small>
        <h2>Evidence could not be loaded</h2>
        <p>{error}</p>
        <button className={styles.secondaryButton} onClick={() => void load()}>
          <Icon name="refresh" /> Try again
        </button>
      </section>
    );
  }

  if (!evidence) {
    return (
      <section
        className={styles.empty}
        aria-labelledby="verification-missing-title"
        data-ui="verification.not-configured"
        data-ui-label="Verification not configured"
      >
        <span className={styles.emptyIcon}>
          <Icon name="test" />
        </span>
        <small>VERIFICATION NOT CONFIGURED</small>
        <h2 id="verification-missing-title">No evidence bundle exists yet</h2>
        <p>
          WTS found the workspace, but its verification evidence has not been
          created. No checks were inferred and nothing was run.
        </p>
        <button className={styles.secondaryButton} onClick={() => void load()}>
          <Icon name="refresh" /> Check again
        </button>
      </section>
    );
  }

  if (!hasPlan) {
    const graphReady = evidence.graphManifest.status === "ready";
    const canBuildGraph = !graphReady && Boolean(onIndexGraph);
    return (
      <div
        className={styles.surface}
        data-ui="verification.no-checks-panel"
        data-ui-label="Verification suggestions panel"
      >
        <section
          aria-labelledby="verification-no-checks-title"
          className={styles.summary}
          data-ui="verification.no-checks-summary"
          data-ui-label="Verification suggestions summary"
          data-status="notRun"
        >
          <div className={styles.statusGlyph} aria-hidden="true">
            <Icon name={graphReady ? "assistant" : "graph"} />
          </div>
          <div className={styles.summaryCopy}>
            <small>VERIFICATION</small>
            <div className={styles.titleLine}>
              <h2 id="verification-no-checks-title">
                No runnable checks discovered
              </h2>
              <span>{graphIndexLabel(evidence.graphManifest.status)}</span>
            </div>
            <p>
              {graphReady
                ? "Ask an agent to inspect the repository graph and propose candidate commands. WTS prepares a review-only brief; it does not run or save the proposal."
                : "Build the workspace graph, then ask an agent to identify candidate commands from repository evidence."}
            </p>
          </div>
          <div className={styles.actions}>
            {canBuildGraph ? (
              <button
                className={styles.primaryButton}
                disabled={buildingGraph}
                onClick={() => void buildGraph()}
                type="button"
              >
                {buildingGraph ? <i /> : <Icon name="graph" />}
                {buildingGraph ? "Building…" : "Build graph"}
              </button>
            ) : (
              <button
                className={styles.primaryButton}
                disabled={!onPrepareCliTask}
                onClick={prepareCliTask}
                type="button"
              >
                <Icon name="assistant" />
                Prepare verification brief
              </button>
            )}
          </div>
        </section>

        {error && (
          <div className={styles.inlineError} role="alert">
            <Icon name="error" />
            <span>{error}</span>
            <button onClick={retryErrorAction}>
              {errorAction ? "Try again" : "Dismiss"}
            </button>
          </div>
        )}

        <details
          className={styles.optionalDisclosure}
          data-ui="verification.no-checks-evidence"
          data-ui-label="Suggested checks evidence"
        >
          <summary>
            <span>
              <b>Evidence and history</b>
              <small>Optional agent-reported context and past runs</small>
            </span>
            <span>{evidence.agentReport.status === "ready" ? "Available" : "No report"}</span>
          </summary>
          {(evidence.verificationHistory?.length ?? 0) > 0 && (
            <VerificationHistory evidence={evidence} />
          )}
          <AgentReportCard
            evidence={evidence}
            lastRefreshedAt={lastRefreshedAt}
            onRefresh={() => void refreshAgentReport()}
            onPromote={(proposalId) => void promoteAgentCheck(proposalId)}
            promotingId={promotingProposalId}
            refreshing={evidenceRefreshing}
          />
        </details>

        <footer className={styles.evidenceFooter}>
          <span>
            Evidence stays local at{" "}
            <code>{evidence.context.evidenceDisplayPath}</code>
          </span>
        </footer>
      </div>
    );
  }

  return (
    <div
      className={styles.surface}
      data-ui="verification.panel"
      data-ui-label="Verification panel"
    >
      <section
        aria-busy={displayStatus === "running"}
        className={styles.summary}
        data-ui="verification.summary"
        data-ui-label="Verification summary"
        data-status={displayStatus}
        aria-labelledby="verification-title"
      >
        <div className={styles.statusGlyph} aria-hidden="true">
          {displayStatus === "passed" ? (
            <Icon name="check" />
          ) : displayStatus === "failed" ? (
            <Icon name="error" />
          ) : displayStatus === "running" ? (
            <i />
          ) : (
            <Icon name="test" />
          )}
        </div>
        <div className={styles.summaryCopy}>
          <small>DETERMINISTIC CHECKS</small>
          <div className={styles.titleLine}>
            <h2 id="verification-title">
              {hasPlan ? statusLabel(displayStatus) : "No runnable checks"}
            </h2>
            {hasPlan && (
              <span>
                {passed} of {total} checks passed
              </span>
            )}
          </div>
          <p>
            {!hasPlan
              ? "WTS did not discover a supported, argument-safe check. Nothing can run until a check is reviewed and added to a supported repository manifest."
              : displayStatus === "running"
                ? "WTS is running only the discovered checks listed below inside the selected worktrees."
                : displayStatus === "passed"
                  ? "Every required check in the current plan completed successfully."
                  : displayStatus === "failed"
                    ? `${firstFailurePlan?.label ?? "A required check"} needs attention${firstFailure?.detail ? ` — ${firstFailure.detail}` : "."}`
                    : displayStatus === "cancelled"
                      ? "The previous run was cancelled. Completed check evidence is preserved; run again when ready."
                    : displayStatus === "stale"
                      ? "The verification plan changed after this result. Run it again before relying on the evidence."
                      : "The discovered plan is ready. No verification command has run yet."}
          </p>
        </div>
        <div className={styles.actions}>
          {hasPlan && displayStatus === "failed" && (
            <button
              className={styles.secondaryButton}
              disabled={state === "running"}
              onClick={() =>
                void (operationalClient.rerunFailedWorkspaceVerification
                  ? rerunFailed()
                  : run())
              }
            >
              <Icon name="refresh" />{" "}
              {operationalClient.rerunFailedWorkspaceVerification
                ? "Rerun failed"
                : "Rerun all"}
            </button>
          )}
          {hasPlan &&
            state === "running" &&
            operationalClient.cancelWorkspaceVerification && (
              <button
                className={styles.cancelButton}
                disabled={activeOperation === "cancel"}
                onClick={() => void cancelRun()}
                type="button"
              >
                {activeOperation === "cancel" ? <i /> : <span aria-hidden="true" />}
                {activeOperation === "cancel" ? "Cancel in progress" : "Cancel run"}
              </button>
            )}
          {hasPlan && (
            <button
              className={styles.primaryButton}
              disabled={state === "running"}
              onClick={() => void run()}
            >
              {state === "running" ? <i /> : <Icon name="play" />}
              {state === "running"
                ? activeOperation === "all"
                  ? "All checks are active"
                  : "Run in progress"
                : "Run all"}
            </button>
          )}
          <button
            className={styles.copyButton}
            onClick={() => void copyContext()}
          >
            <Icon name="copy" /> Copy context
          </button>
        </div>
        {displayStatus === "running" && (
          <div className={styles.progress} aria-hidden="true">
            <i />
          </div>
        )}
      </section>

      <details
        className={styles.automation}
        data-ui="verification.automation"
        data-ui-label="Verification automation"
      >
        <summary>
          <span>
            <b>After agent work</b>
            <small>Run reviewed automation while WTS is open</small>
          </span>
          <span>
            Checks {automation.automaticVerification ? "on" : "off"} · Agent
            review {automation.automaticAgentReview ? "on" : "off"}
          </span>
        </summary>
        <div>
          <label>
            <input
              checked={automation.automaticVerification}
              onChange={(event) => {
                const next = {
                  ...automation,
                  automaticVerification: event.target.checked,
                };
                setAutomation(next);
                saveWorkspaceAutomation(next);
              }}
              type="checkbox"
            />
            <span>
              <b>Run deterministic checks</b>
              <small>Start the trusted check plan after an agent finishes.</small>
            </span>
          </label>
          <label>
            <input
              checked={automation.automaticAgentReview}
              onChange={(event) => {
                const next = {
                  ...automation,
                  automaticAgentReview: event.target.checked,
                };
                setAutomation(next);
                saveWorkspaceAutomation(next);
              }}
              type="checkbox"
            />
            <span>
              <b>Ask an agent for review guidance</b>
              <small>
                Build a review order, risks, and questions. This can use your
                configured agent provider.
              </small>
            </span>
          </label>
        </div>
      </details>

      {error && (
        <div className={styles.inlineError} role="alert">
          <Icon name="error" />
          <span>{error}</span>
          <button onClick={retryErrorAction}>
            {errorAction ? "Try again" : "Dismiss"}
          </button>
        </div>
      )}

      {hasPlan && (
        <div
          className={styles.checks}
          data-ui="verification.checks"
          data-ui-label="Verification checks"
        >
          <header className={styles.checksHeader}>
            <span>
              <h3>Checks</h3>
            </span>
            <dl>
              <div>
                <dt>Last run</dt>
                <dd>
                  {lastRunLabel(
                    evidence.verificationResult.completedAtUnixMs ??
                      evidence.verificationResult.startedAtUnixMs,
                  )}
                </dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{compactDuration(evidence.verificationResult.durationMs)}</dd>
              </div>
            </dl>
          </header>
          {groups.map(([label, checks]) => (
            <section className={styles.group} key={label}>
              <header>
                <span>{label.slice(0, 2).toUpperCase()}</span>
                <b>{label}</b>
                <small>
                  {checks.filter((check) => check.result?.status === "passed").length}/
                  {checks.length} passed
                </small>
              </header>
              <div>
                {checks.map((check) => (
                  <CheckRow
                    active={activeOperation === `check:${check.plan.id}`}
                    item={check}
                    key={check.plan.id}
                    onRun={
                      operationalClient.runWorkspaceVerificationCheck
                        ? (checkId, label) => void runCheck(checkId, label)
                        : undefined
                    }
                    running={state === "running"}
                  />
                ))}
              </div>
            </section>
          ))}
          {evidence && failedChecks.length > 0 && (
            <VerificationFeedbackPanel
              client={client}
              evidence={evidence}
              onNotice={onNotice}
              workspaceId={workspaceId}
              workspaceKey={workspaceKey}
            />
          )}
        </div>
      )}

      <details
        className={styles.optionalDisclosure}
        data-ui="verification.coverage"
        data-ui-label="Verification coverage"
      >
        <summary>
          <span>
            <b>Improve coverage</b>
            <small>Build the graph and prepare suggested checks</small>
          </span>
          <span>{graphIndexLabel(evidence.graphManifest.status)}</span>
        </summary>
        <section
          aria-busy={buildingGraph}
          aria-labelledby="verification-planning-title"
          className={styles.planningCard}
          data-graph={evidence.graphManifest.status}
        >
          <span className={styles.planningIcon} aria-hidden="true">
            <Icon name="graph" />
          </span>
          <div className={styles.planningCopy}>
            <span className={styles.planningEyebrow}>
              <small>OPTIONAL COVERAGE</small>
            </span>
            <h3 id="verification-planning-title">Find gaps in verification</h3>
            <p>
              {evidence.graphManifest.status === "ready"
                ? "Use the repository graph to prepare a read-only brief that suggests additional checks. Nothing runs or saves automatically."
                : onIndexGraph
                  ? "Build a repository graph before asking an agent to map missing checks."
                  : "Prepare a brief that asks for a graph build before making verification recommendations."}
            </p>
            {evidence.graphManifest.status === "ready" && (
              <small className={styles.freshnessNote}>
                The graph may not include your latest local changes.
              </small>
            )}
          </div>
          <div aria-label="Coverage actions" className={styles.planningActions} role="group">
            {evidence.graphManifest.status === "ready" && onPrepareCliTask && (
              <button
                className={`${styles.planningButton} ${styles.planningPrimaryButton}`}
                onClick={prepareCliTask}
                type="button"
              >
                <Icon name="assistant" />
                Prepare verification brief
              </button>
            )}
            {onIndexGraph && (
              <button
                className={styles.planningButton}
                disabled={buildingGraph}
                onClick={() => void buildGraph()}
                type="button"
              >
                {buildingGraph ? <i /> : <Icon name="graph" />}
                {buildingGraph
                  ? "Building graph…"
                  : evidence.graphManifest.status === "ready"
                    ? "Rebuild graph"
                    : evidence.graphManifest.status === "failed"
                      ? "Rebuild graph"
                      : "Build graph"}
              </button>
            )}
          </div>
        </section>
      </details>

      <details
        className={styles.optionalDisclosure}
        data-ui="verification.evidence"
        data-ui-label="Verification evidence"
      >
        <summary>
          <span>
            <b>Evidence and history</b>
            <small>Past runs and optional agent-reported context</small>
          </span>
          <span>{evidence.agentReport.status === "ready" ? "Available" : "No report"}</span>
        </summary>
        {(evidence.verificationHistory?.length ?? 0) > 0 && (
          <VerificationHistory evidence={evidence} />
        )}
        <AgentReportCard
          evidence={evidence}
          lastRefreshedAt={lastRefreshedAt}
          onRefresh={() => void refreshAgentReport()}
          onPromote={(proposalId) => void promoteAgentCheck(proposalId)}
          promotingId={promotingProposalId}
          refreshing={evidenceRefreshing}
        />
      </details>

      <footer className={styles.evidenceFooter}>
        <span>
          Evidence stays local at <code>{evidence.context.evidenceDisplayPath}</code>
        </span>
      </footer>
    </div>
  );
}
