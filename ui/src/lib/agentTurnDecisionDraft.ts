import { validateRecordAgentTurnDecision, type AgentTurnDecisionKind, type RecordAgentTurnDecisionRequest } from "./agentTurnDecisions";
export const DECISION_DRAFT_KEY = "wts.agent-turn-decision-drafts.v1";
export interface AgentTurnDecisionDraft { key: string; kind?: AgentTurnDecisionKind; reason: string; pending?: RecordAgentTurnDecisionRequest; needsRefresh?: boolean; }
const storageError = () => { throw new Error("WTS could not save the decision draft. Check browser storage before you continue."); };
function drafts(): AgentTurnDecisionDraft[] {
  try {
    const raw = localStorage.getItem(DECISION_DRAFT_KEY); if (!raw) return [];
    const value = JSON.parse(raw); if (!Array.isArray(value) || value.length > 64) return storageError();
    const keys = new Set<string>();
    for (const item of value) {
      if (!item || typeof item.key !== "string" || !item.key || item.key.length > 16384 || keys.has(item.key) || typeof item.reason !== "string" || new TextEncoder().encode(item.reason).length > 16384) return storageError();
      keys.add(item.key);
      if (item.kind !== undefined && !["accepted", "kept", "rejected"].includes(item.kind)) return storageError();
      if (item.needsRefresh !== undefined && typeof item.needsRefresh !== "boolean") return storageError();
      if (item.pending !== undefined) validateRecordAgentTurnDecision(item.pending, storageError);
    }
    return value;
  } catch { return storageError(); }
}
export function readAgentTurnDecisionDraft(key: string): AgentTurnDecisionDraft { return drafts().find(item => item.key === key) ?? { key, reason: "" }; }
export function saveAgentTurnDecisionDraft(draft: AgentTurnDecisionDraft) {
  if (!draft.key || draft.key.length > 16384 || typeof draft.reason !== "string" || new TextEncoder().encode(draft.reason).length > 16384 || (draft.kind !== undefined && !["accepted", "kept", "rejected"].includes(draft.kind))) return storageError();
  if (draft.pending) validateRecordAgentTurnDecision(draft.pending, storageError);
  const entries = drafts().filter(item => item.key !== draft.key);
  if (draft.kind || draft.reason || draft.pending || draft.needsRefresh) {
    if (entries.length >= 64) throw new Error("Discard an earlier decision draft before you start another one. WTS kept your drafts.");
    entries.push(draft);
  }
  try { localStorage.setItem(DECISION_DRAFT_KEY, JSON.stringify(entries)); } catch { storageError(); }
}
