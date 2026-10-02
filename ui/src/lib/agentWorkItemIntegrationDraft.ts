import { validateIntegrateAgentWorkItem, type IntegrateAgentWorkItemRequest } from "./agentWorkSets";
const KEY = "wts.agent-work-item-integrations.v1";
const failure = () => { throw new Error("Could not save this integration request. Check browser storage before you apply files."); };
function read(): { key: string; request: IntegrateAgentWorkItemRequest }[] {
  try { const raw = localStorage.getItem(KEY); if (!raw) return []; const entries = JSON.parse(raw); if (!Array.isArray(entries) || entries.length > 64) return failure(); const ids = new Set<string>(); for (const entry of entries) { if (!entry || typeof entry.key !== "string" || !entry.key || entry.key.length > 8192 || ids.has(entry.key)) return failure(); ids.add(entry.key); validateIntegrateAgentWorkItem(entry.request, failure); } return entries; } catch { return failure(); }
}
export function readPendingWorkItemIntegration(key: string) { return read().find(entry => entry.key === key)?.request; }
export function savePendingWorkItemIntegration(key: string, request?: IntegrateAgentWorkItemRequest) {
  const entries = read().filter(entry => entry.key !== key);
  if (request) { validateIntegrateAgentWorkItem(request, failure); if (entries.length >= 64) throw new Error("64 integration requests are pending. Open an earlier candidate to read its status."); entries.push({ key, request }); }
  try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch { failure(); }
}
