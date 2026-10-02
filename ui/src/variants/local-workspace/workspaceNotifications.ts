import type { WorkspaceEvidence } from "../../lib/wtsClient";
import type { WorkflowAgentSignal } from "./workspaceWorkflow";

const NOTIFIED_EVENTS_KEY = "wts.workspace-notified-events.v1";

export interface WorkspaceNotificationSignal extends WorkflowAgentSignal {
  activity: string;
  latestUpdate?: string;
  lastEventAtUnixMs: number;
  needsInput?: "question" | "access";
}

export interface WorkspaceNotificationContent {
  title: string;
  body: string;
}

export function notificationForWorkspaceAgent(
  workspaceName: string,
  signal: WorkspaceNotificationSignal,
): WorkspaceNotificationContent | null {
  if (signal.needsInput === "question") {
    return {
      title: `${workspaceName} needs your answer`,
      body: "Agent has a question. Open WTS to review it.",
    };
  }
  if (signal.needsInput === "access") {
    return {
      title: `${workspaceName} needs access`,
      body: "Agent needs access. Open WTS to review the request.",
    };
  }
  if (signal.state === "attention") {
    return {
      title: `${workspaceName} needs attention`,
      body: signal.latestUpdate?.trim() || signal.activity,
    };
  }
  if (signal.updateKind === "completion") {
    return {
      title: `${workspaceName} is ready for review`,
      body: signal.latestUpdate?.trim() || signal.activity,
    };
  }
  return null;
}

export function notificationForWorkspaceVerification(
  workspaceName: string,
  evidence: WorkspaceEvidence,
): WorkspaceNotificationContent | null {
  const status = evidence.verificationResult.status;
  if (status !== "failed" && status !== "blocked") return null;

  const result = evidence.verificationResult.checks.find(
    (check) => check.status === "failed" || check.status === "timedOut",
  );
  const plan = evidence.verificationPlan.checks.find(
    (check) => check.id === result?.checkId,
  );
  const detail = result?.detail.trim();
  const label = plan?.label.trim();
  return {
    title: `${workspaceName} verification failed`,
    body:
      label && detail
        ? `${label}: ${detail}`
        : detail || label || "Open Verification to review the failed checks.",
  };
}

export function workspaceNotificationWasSent(
  workspaceId: string,
  eventAtUnixMs: number,
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): boolean {
  if (
    !storage ||
    !workspaceId.trim() ||
    !Number.isSafeInteger(eventAtUnixMs) ||
    eventAtUnixMs < 0
  ) {
    return false;
  }
  try {
    const current = JSON.parse(
      storage.getItem(NOTIFIED_EVENTS_KEY) ?? "{}",
    ) as Record<string, unknown>;
    const sentAt = current[workspaceId];
    return typeof sentAt === "number" && sentAt >= eventAtUnixMs;
  } catch {
    return false;
  }
}

/** Persist deduplication only after the external notification succeeds. */
export function markWorkspaceNotificationSent(
  workspaceId: string,
  eventAtUnixMs: number,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined =
    globalThis.localStorage,
): boolean {
  if (
    !storage ||
    !workspaceId.trim() ||
    !Number.isSafeInteger(eventAtUnixMs) ||
    eventAtUnixMs < 0
  ) {
    return false;
  }
  try {
    const current = JSON.parse(
      storage.getItem(NOTIFIED_EVENTS_KEY) ?? "{}",
    ) as Record<string, unknown>;
    storage.setItem(
      NOTIFIED_EVENTS_KEY,
      JSON.stringify({ ...current, [workspaceId]: eventAtUnixMs }),
    );
    return true;
  } catch {
    return false;
  }
}
