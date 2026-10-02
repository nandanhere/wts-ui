/**
 * Graphify UI components — barrel export.
 *
 * Exports:
 *   GraphifyPanel      — Main panel component for integration agents
 *   GraphifyRepoRow    — Single repo row (expandable, lazy ops)
 *
 * Mounting example:
 *   import { GraphifyPanel } from "@/components/graphify";
 *
 *   <GraphifyPanel
 *     workspacePath={workspace.filePath}
 *     repoIds={repos.map(r => r.id)}
 *   />
 *
 * Types are re-exported from @/lib/graphify/types.
 */

export { GraphifyPanel } from "./graphify-panel";
export type { GraphifyPanelProps } from "./graphify-panel";
export { GraphifyRepoRow } from "./graphify-repo-row";
