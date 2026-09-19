import { useState } from "react";
import type {
  AgentProvider,
  CodeReviewFinding,
  CodeReviewFindingSeverity,
  CodeReviewScope,
  WorkspaceClient,
  WorkspaceCodeReviewResult,
} from "../../lib/wtsClient";
import styles from "./WorkspaceCodeReviewCard.module.css";

interface WorkspaceCodeReviewCardProps {
  client: WorkspaceClient;
  workspaceId: string;
  workspaceKey: string;
  onNotice?: (message: string, kind?: "info" | "error") => void;
}

function providerLabel(provider: AgentProvider): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "openCode":
      return "OpenCode";
    case "hermes":
      return "Hermes";
    case "copilot":
      return "VS Code Copilot";
  }
}

function severityClass(severity: CodeReviewFindingSeverity) {
  switch (severity) {
    case "critical":
      return styles.severityCritical;
    case "warning":
      return styles.severityWarning;
    case "suggestion":
      return styles.severitySuggestion;
  }
}

export function WorkspaceCodeReviewCard({
  client,
  workspaceId,
  workspaceKey,
  onNotice,
}: WorkspaceCodeReviewCardProps) {
  const [scope, setScope] = useState<CodeReviewScope>("recentChanges");
  const [provider, setProvider] = useState<AgentProvider>("copilot");
  const [model, setModel] = useState("auto");
  const [running, setRunning] = useState(false);
  const [reviewResult, setReviewResult] =
    useState<WorkspaceCodeReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const openForManualReview = async () => {
    setOpening(true);
    setError(null);
    try {
      const result = await client.openWorkspaceInVscode(workspaceId);
      if (!result.accepted || result.workspaceId !== workspaceId) throw new Error("WTS could not open this workspace.");
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : "WTS could not open VS Code."} Open VS Code, then open the saved workspace file.`);
    } finally { setOpening(false); }
  };

  const runReview = async () => {
    if (!client.runWorkspaceCodeReview) {
      setError("AI code review is not available in this client.");
      return;
    }
    setRunning(true);
    setError(null);
    onNotice?.(`${workspaceKey} · Starting AI code review…`);

    try {
      const trimmedModel = model.trim();
      const result = await client.runWorkspaceCodeReview(
        workspaceId,
        provider,
        scope,
        trimmedModel || undefined,
      );
      setReviewResult(result);
      onNotice?.(`${workspaceKey} · Code review finished`);
    } catch (cause) {
      const msg =
        cause instanceof Error ? cause.message : "Code review failed.";
      setError(msg);
      onNotice?.(`${workspaceKey} · ${msg}`, "error");
    } finally {
      setRunning(false);
    }
  };

  return (
    <section
      className={styles.card}
      data-ui="verification.code-review"
      data-ui-label="AI code review"
    >
      <header className={styles.header}>
        <div className={styles.headerText}>
          <b>AI Code Review</b>
          <small>
            Examine recent changes or the complete workspace with an AI model.
          </small>
        </div>
        <div className={styles.controls}>
          <label className={styles.controlGroup}>
            <span>Scope:</span>
            <select
              aria-label="Code review scope"
              disabled={running}
              onChange={(e) => setScope(e.target.value as CodeReviewScope)}
              value={scope}
            >
              <option value="recentChanges">Recent changes</option>
              <option value="totalCode">Total code</option>
            </select>
          </label>
          <label className={styles.controlGroup}>
            <span>Provider:</span>
            <select
              aria-label="Code review provider"
              disabled={running}
              onChange={(e) => {
                const nextProvider = e.target.value as AgentProvider;
                setProvider(nextProvider);
                if (nextProvider === "copilot" && !model) {
                  setModel("auto");
                }
              }}
              value={provider}
            >
              <option value="copilot">VS Code Copilot</option>
              <option value="codex">Codex</option>
              <option value="openCode">OpenCode</option>
              <option value="hermes">Hermes</option>
            </select>
          </label>
          <label className={styles.controlGroup}>
            <span>Model:</span>
            <input
              aria-label="Code review model"
              className={styles.modelInput}
              data-ui="verification.code-review-model"
              data-ui-label="Code review model"
              disabled={running}
              list="code-review-models"
              onChange={(e) => setModel(e.target.value)}
              placeholder={provider === "copilot" ? "auto" : "default"}
              value={model}
            />
            <datalist id="code-review-models">
              {provider === "copilot" ? (
                <>
                  <option value="auto">auto (Copilot default)</option>
                  <option value="claude-3.7-sonnet">claude-3.7-sonnet</option>
                  <option value="claude-3.5-sonnet">claude-3.5-sonnet</option>
                  <option value="gpt-4o">gpt-4o</option>
                  <option value="o3-mini">o3-mini</option>
                  <option value="gemini-2.5-pro">gemini-2.5-pro</option>
                </>
              ) : provider === "codex" ? (
                <>
                  <option value="o3-mini">o3-mini</option>
                  <option value="gpt-4o">gpt-4o</option>
                  <option value="o1">o1</option>
                </>
              ) : (
                <>
                  <option value="default">default</option>
                </>
              )}
            </datalist>
          </label>
          <button
            className={styles.reviewButton}
            disabled={running || !client.runWorkspaceCodeReview}
            onClick={runReview}
            type="button"
          >
            {running ? "Reviewing code…" : "Review code"}
          </button>
        </div>
      </header>

      {!client.runWorkspaceCodeReview && <div className={styles.errorBanner} role="status"><p>This client cannot run AI reviews. Open the workspace in VS Code to review its changes.</p><button disabled={opening} onClick={() => void openForManualReview()} type="button">Open workspace in VS Code</button></div>}
      {error && <div className={styles.errorBanner} role="alert">{error}</div>}

      {reviewResult && (
        <>
          <div className={styles.reviewMeta}>
            <span>
              Reviewed by {providerLabel(reviewResult.provider)}
              {reviewResult.model || reviewResult.agent
                ? ` (model: ${reviewResult.model || reviewResult.agent})`
                : ""} ·{" "}
              {reviewResult.scope === "recentChanges"
                ? "Recent changes"
                : "Total code"}
            </span>
          </div>
          <div className={styles.summaryBanner}>
            <b>Summary:</b> {reviewResult.summary}
          </div>

          {reviewResult.findings.length > 0 && (
            <div className={styles.findingsList}>
              <b>Findings ({reviewResult.findings.length})</b>
              {reviewResult.findings.map((finding: CodeReviewFinding) => (
                <div className={styles.findingCard} key={finding.findingId}>
                  <div className={styles.findingHeader}>
                    <span className={styles.findingTitle}>{finding.title}</span>
                    <span
                      className={`${styles.severityTag} ${severityClass(
                        finding.severity,
                      )}`}
                    >
                      {finding.severity}
                    </span>
                  </div>
                  <div className={styles.findingLocation}>
                    {finding.filePath}
                    {finding.line ? `:${finding.line}` : ""}
                  </div>
                  <p className={styles.findingExplanation}>
                    {finding.explanation}
                  </p>
                  {finding.suggestedPatch && (
                    <pre className={styles.patchBlock}>
                      {finding.suggestedPatch}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}

          {reviewResult.actionableSteps.length > 0 && (
            <div className={styles.stepsList}>
              <b>Actionable steps:</b>
              {reviewResult.actionableSteps.map((step) => (
                <div className={styles.stepItem} key={step.stepNumber}>
                  <span className={styles.stepNumber}>
                    {step.stepNumber}.
                  </span>
                  <span>{step.instruction}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
