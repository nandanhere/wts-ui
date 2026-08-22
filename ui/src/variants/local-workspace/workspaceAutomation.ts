import type {
  AgentProvider,
  WorkspaceClient,
  WorkspaceEvidence,
} from "../../lib/wtsClient";

const WORKSPACE_AUTOMATION_KEY = "wts.workspace-automation.v1";
const WORKSPACE_AUTOMATION_EVENTS_KEY = "wts.workspace-automation-events.v1";
const RECENT_COMPLETION_MS = 10 * 60 * 1_000;

export interface WorkspaceAutomationPreference {
  schemaVersion: 1;
  automaticVerification: boolean;
  automaticAgentReview: boolean;
  quietPeriodSeconds: number;
}

export const defaultWorkspaceAutomation: WorkspaceAutomationPreference = {
  schemaVersion: 1,
  automaticVerification: true,
  automaticAgentReview: false,
  quietPeriodSeconds: 15,
};

export interface WorkspaceAutomationResult {
  verification: "skipped" | "completed" | "failed";
  agentReview: "skipped" | "completed" | "failed";
  verificationEvidence: WorkspaceEvidence | null;
}

export function loadWorkspaceAutomation(
  storage: Pick<Storage, "getItem" | "removeItem"> | undefined =
    globalThis.localStorage,
): WorkspaceAutomationPreference {
  if (!storage) return defaultWorkspaceAutomation;
  try {
    const raw = storage.getItem(WORKSPACE_AUTOMATION_KEY);
    if (!raw) return defaultWorkspaceAutomation;
    const value = JSON.parse(raw) as Partial<WorkspaceAutomationPreference>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.automaticVerification !== "boolean" ||
      typeof value.automaticAgentReview !== "boolean" ||
      typeof value.quietPeriodSeconds !== "number" ||
      !Number.isSafeInteger(value.quietPeriodSeconds) ||
      value.quietPeriodSeconds < 0 ||
      value.quietPeriodSeconds > 300
    ) {
      storage.removeItem(WORKSPACE_AUTOMATION_KEY);
      return defaultWorkspaceAutomation;
    }
    return value as WorkspaceAutomationPreference;
  } catch {
    try {
      storage.removeItem(WORKSPACE_AUTOMATION_KEY);
    } catch {
      // Storage is optional. The in-memory defaults remain safe.
    }
    return defaultWorkspaceAutomation;
  }
}

export function saveWorkspaceAutomation(
  value: WorkspaceAutomationPreference,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
) {
  if (!storage) return false;
  try {
    storage.setItem(WORKSPACE_AUTOMATION_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function workspaceCompletionIsRecent(
  completedAtUnixMs: number,
  nowUnixMs: number,
) {
  const age = nowUnixMs - completedAtUnixMs;
  return age >= 0 && age <= RECENT_COMPLETION_MS;
}

export function claimWorkspaceAutomation(
  workspaceId: string,
  eventAtUnixMs: number,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined =
    globalThis.localStorage,
) {
  if (!storage || !workspaceId.trim() || eventAtUnixMs < 0) return false;
  try {
    const current = JSON.parse(
      storage.getItem(WORKSPACE_AUTOMATION_EVENTS_KEY) ?? "{}",
    ) as Record<string, unknown>;
    const previous = current[workspaceId];
    if (typeof previous === "number" && previous >= eventAtUnixMs) return false;
    storage.setItem(
      WORKSPACE_AUTOMATION_EVENTS_KEY,
      JSON.stringify({ ...current, [workspaceId]: eventAtUnixMs }),
    );
    return true;
  } catch {
    return false;
  }
}

const AGENT_REVIEW_PROMPT =
  "Review all current workspace changes for a human reviewer. Suggest a review order, list correctness risks, identify missing verification, and ask each decision question explicitly. Publish the bounded result through wts-report. Do not modify code.";

export async function runWorkspaceCompletionAutomation(
  client: WorkspaceClient,
  workspaceId: string,
  provider: AgentProvider | null,
  preference: WorkspaceAutomationPreference,
): Promise<WorkspaceAutomationResult> {
  let verification: WorkspaceAutomationResult["verification"] = "skipped";
  let agentReview: WorkspaceAutomationResult["agentReview"] = "skipped";
  let verificationEvidence: WorkspaceEvidence | null = null;

  if (preference.automaticVerification) {
    try {
      verificationEvidence = await client.runWorkspaceVerification(workspaceId);
      verification = "completed";
    } catch {
      verification = "failed";
    }
  }

  if (preference.automaticAgentReview && provider) {
    try {
      const evidence =
        verificationEvidence ?? (await client.getWorkspaceEvidence(workspaceId));
      if (evidence?.graphManifest.status !== "ready") {
        await client.indexWorkspaceGraph(workspaceId);
      }
      await client.runWorkspaceAgent(
        workspaceId,
        provider,
        AGENT_REVIEW_PROMPT,
      );
      agentReview = "completed";
    } catch {
      agentReview = "failed";
    }
  }

  return { verification, agentReview, verificationEvidence };
}
