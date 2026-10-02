export type State = "working" | "question" | "waiting" | "done" | "failed" | "stopped";
export type Scenario = "team" | "busy" | "failure" | "empty";
export interface Execution { id: string; parent?: string; title: string; role: string; provider: string; model: string; state: State; file: string; summary: string; intervals: [number, number][]; }
export const stateLabels: Record<State, string> = { working: "Working", question: "Needs you", waiting: "Waiting for team", done: "Finished", failed: "Failed", stopped: "Stopped" };
export function initialExecutions(scenario: Scenario): Execution[] {
  if (scenario === "empty") return [];
  const executions: Execution[] = [
    { id: "lead", title: "Workspace setup", role: "Coordinator", provider: "Codex", model: "gpt-6-astra", state: "waiting", file: "docs/workspace-setup.md", summary: "The URL flow is ready. Waiting for service detection, review, and browser checks before preparing the result.", intervals: [[0,3],[28,30]] },
    { id: "ui", parent: "lead", title: "Repository URL flow", role: "Implementation", provider: "Codex", model: "gpt-6-astra", state: "working", file: "NewWorkspaceDialog.tsx", summary: "Adding a direct URL field and checking the next step. Existing local repositories remain available.", intervals: [[3,23]] },
    { id: "runtime", parent: "lead", title: "Service detection", role: "Implementation", provider: "Codex", model: "gpt-6-astra", state: "working", file: "runtime_analysis.rs", summary: "Checking Python entry points and Docker commands against the fleet-status repository.", intervals: [[4,22]] },
    { id: "review", parent: "lead", title: "Review setup behavior", role: "Raptik review", provider: "Codex", model: "gpt-6-astra", state: "question", file: "runtime_analysis.rs", summary: "One decision needs your input before the review can finish. The detected maintenance task can change remote state.", intervals: [[12,26]] },
    { id: "qa", parent: "lead", title: "Verify desktop flow", role: "Test coordinator", provider: "Codex", model: "gpt-6-astra", state: "waiting", file: "workspace-setup.spec.ts", summary: "Delegated the desktop flow to a browser worker. Waiting for the result; no own work is running.", intervals: [[8,10]] },
    { id: "browser", parent: "qa", title: "URL → services → ready", role: "Browser subagent", provider: "Codex", model: "Not reported", state: "working", file: "workspace-setup.spec.ts", summary: "Checking the path from a pasted repository URL to a workspace with detected services.", intervals: [[10,28]] },
  ];
  if (scenario === "failure") executions.find(a=>a.id === "browser")!.state = "failed";
  if (scenario === "busy") for (let i=0;i<14;i++) executions.push({ id: `extra-${i}`, title: ["Check worktree state", "Review agent metrics", "Update setup guide", "Verify model picker"][i%4]+` ${Math.floor(i/4)+1}`, role: "Independent agent", provider: "Codex", model: "Not reported", state: i%5 === 0 ? "done" : "working", file: "wts-ui", summary: "Independent task in this workspace. It does not belong to the setup coordinator.", intervals: [[i%8+2, i%8+14]] });
  return executions;
}
export function descendants(executions: Execution[], id: string): string[] {
  const found = new Set<string>([id]);
  for (let changed=true; changed;) { changed=false; for (const a of executions) if(a.parent && found.has(a.parent) && !found.has(a.id)) { found.add(a.id); changed=true; } }
  return [...found];
}
export function metrics(executions: Execution[]) {
  const unique = [...new Map(executions.map(a=>[a.id,a])).values()];
  const total = unique.reduce((sum,a)=>sum+a.intervals.reduce((t,[s,e])=>t+Math.max(0,e-s),0),0);
  const segments = Array.from({length:30},(_,minute)=>unique.filter(a=>a.intervals.some(([s,e])=>s<=minute && minute<e)).length);
  const elapsed = segments.filter(n=>n>0).length;
  return { total, elapsed, peak: Math.max(0,...segments), parallelism: elapsed ? total/elapsed : 0, segments, working:unique.filter(a=>a.state==="working").length, questions:unique.filter(a=>a.state==="question").length, failed:unique.filter(a=>a.state==="failed").length };
}
export function stopExecutions(executions: Execution[], id: string, subtree: boolean) {
  const ids = new Set(subtree ? descendants(executions,id) : [id]);
  return executions.map(a=>ids.has(a.id) && a.state!=="done" ? {...a,state:"stopped" as const} : a);
}
export function workspaceExecutions(workspace: string, scenario: Scenario): Execution[] {
  const agents=initialExecutions(scenario);
  if(workspace==='wts-ui') return agents;
  const beacon=workspace==='operation: kill beacon';
  const titles=beacon?['Provisioning review','Check boot behavior','Check API contracts','Review remote effects','Verify provisioning','Boot → inspect → ready']:['Fleet-status startup','Repository setup','Detect Python services','Review startup policy','Verify service launch','URL → services → ready'];
  return agents.map((a,i)=>i<6?{...a,title:titles[i],file:beacon?'provisioning.go':a.file,summary:i===0?(beacon?'Reviewing the provisioning changes. Waiting for contract checks and verification before preparing the result.':'Checking the fleet-status setup. Waiting for service detection and a decision on maintenance tasks.'):a.summary}:a);
}
