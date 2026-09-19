import { validateRestoreAgentTurn, validateRunAgentTurnCheck, type RestoreAgentTurnRequest, type RunAgentTurnCheckRequest } from "./agentTurnActions";
export const TURN_ACTION_STORAGE_KEY = "wts.agent-turn-actions.v1";
export type PendingTurnAction = { key: string; kind: "check"; request: RunAgentTurnCheckRequest } | { key: string; kind: "restore"; request: RestoreAgentTurnRequest };
const unavailable = () => { throw new Error("WTS could not save the request for a safe retry. Check browser storage, then try again."); };
function read(): PendingTurnAction[] {
  try {
    const raw = localStorage.getItem(TURN_ACTION_STORAGE_KEY);
    if (!raw) return [];
    const value = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > 64) return unavailable();
    const keys = new Set<string>();
    for (const item of value) {
      if (!item || typeof item.key !== "string" || !item.key || item.key.length > 16384 || keys.has(`${item.kind}:${item.key}`)) return unavailable();
      keys.add(`${item.kind}:${item.key}`);
      if (item.kind === "check") validateRunAgentTurnCheck(item.request, unavailable);
      else if (item.kind === "restore") validateRestoreAgentTurn(item.request, unavailable);
      else return unavailable();
    }
    return value;
  } catch { return unavailable(); }
}
export function readPendingTurnAction(key: string, kind: PendingTurnAction["kind"]) { return read().find(item => item.key === key && item.kind === kind); }
export function savePendingTurnAction(action: PendingTurnAction) {
  const entries = read(); const existing = entries.find(item => item.key === action.key && item.kind === action.kind);
  if (existing && JSON.stringify(existing) !== JSON.stringify(action)) throw new Error("WTS must finish the saved request before it can send another request.");
  if (!existing) { if (entries.length >= 64) throw new Error("Refresh an earlier task action before you start another one. WTS kept the saved requests."); entries.push(action); }
  try { localStorage.setItem(TURN_ACTION_STORAGE_KEY, JSON.stringify(entries)); } catch { unavailable(); }
}
export function clearPendingTurnAction(action: PendingTurnAction) {
  const entries = read().filter(item => item.key !== action.key || item.kind !== action.kind || item.request.requestId !== action.request.requestId);
  try { localStorage.setItem(TURN_ACTION_STORAGE_KEY, JSON.stringify(entries)); } catch { unavailable(); }
}
