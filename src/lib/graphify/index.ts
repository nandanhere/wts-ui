/**
 * Graphify capability layer — barrel export.
 *
 * Modules:
 *   types     — TypeScript interfaces for graphify metadata
 *   provider  — Read-only filesystem detection (safe, no graph.json loading)
 *   server    — Composition with workspace discovery contracts
 *
 * This layer is lightweight and optional.  Absence of graphify artifacts
 * in any repo is non-fatal (returns available: false).
 */

export * from "./types";
export { buildGraphifyStatus, detectArtifacts, isGraphifyCliAvailable } from "./provider";
export { enrichReposWithGraphify, enrichSingleRepo } from "./server";
