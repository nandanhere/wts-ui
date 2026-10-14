/**
 * Integration extension model — public API.
 *
 * Usage (server-side):
 * ```ts
 * import { createRegistry, buildManifest, buildContext } from "@/lib/integrations";
 * import { getOpenedWorkspaceFilePath, getAllRepos } from "@/lib/git/registry";
 *
 * const ctx = buildContext(getOpenedWorkspaceFilePath(), getAllRepos());
 * const manifest = await buildManifest(ctx);
 * ```
 */

export { IntegrationRegistry } from "./registry";
export { buildManifest } from "./manifest";
export { buildContext } from "./context";
export { sanitizeBlock, sanitizeBlocks, isValidSafeUrl } from "./sanitizer";
export { BUILT_IN_PROVIDERS } from "./providers";
export { IntegrationValidationError } from "./types";

export type {
  IntegrationProvider,
  WorkspaceIntegrationContext,
  WorkspaceRepoInfo,
  WorkspaceManifest,
  ProviderManifestEntry,
  ProviderState,
  Capability,
  RiskLevel,
  ToolDescriptor,
  UiBlock,
  NoticeBlock,
  MetricListBlock,
  StatusListBlock,
  LinkListBlock,
  MetricItem,
  StatusItem,
  LinkItem,
} from "./types";
export type { IntegrationRegistryConfig } from "./types";
