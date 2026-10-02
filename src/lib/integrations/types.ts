/**
 * Integration extension model — core types for the trusted provider contract.
 *
 * # Trust boundary
 * - All provider code is built-in (no dynamic imports, no workspace files).
 * - WorkspaceIntegrationContext is constructed server-side from authoritative
 *   sources only (getOpenedWorkspaceFilePath() + getAllRepos()).
 * - Browser input MUST NOT supply filesystem paths.
 * - Provider-returned values are sanitized before API response.
 */

/* ------------------------------------------------------------------ */
/*  Capability & risk                                                  */
/* ------------------------------------------------------------------ */

/** Union of anticipated integration capabilities. */
export type Capability =
  | "context"
  | "metrics"
  | "diagnostics"
  | "dependencies"
  | "documentation"
  | "reviews"
  | "tools";

/** Risk level for an integration provider. */
export type RiskLevel = "readonly" | "low" | "medium" | "high";

/* ------------------------------------------------------------------ */
/*  Tool descriptor (metadata only — no executor yet)                  */
/* ------------------------------------------------------------------ */

/**
 * Describes a tool this integration *would* provide.
 * Metadata only — execution is out of scope for 0.5.0.
 *
 * Invariant: if `risk` is not "readonly", `requiresApproval` MUST be true.
 */
export interface ToolDescriptor {
  /** Stable identifier (kebab-case). */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Short description of what the tool does. */
  description: string;
  /** Whether user confirmation is required before invocation. */
  requiresApproval: boolean;
  /** Risk level of this specific tool. */
  risk: RiskLevel;
}

/* ------------------------------------------------------------------ */
/*  Structured UI blocks (discriminated union, bounded, safe)          */
/* ------------------------------------------------------------------ */

/** Base block — all blocks share these fields. */
interface UiBlockBase {
  /** Stable identifier for this block within the provider. */
  id: string;
  /** Human-readable title. */
  title: string;
}

/** A notice/info banner — no interactive elements. */
export interface NoticeBlock extends UiBlockBase {
  type: "notice";
  /** Short message text (sanitized, bounded to 500 chars). */
  message: string;
  /** Optional severity tint. */
  severity?: "info" | "warn" | "error";
}

/** A list of key-value metric tiles. */
export interface MetricListBlock extends UiBlockBase {
  type: "metric-list";
  /** Metrics array (bounded to 20 items). */
  items: MetricItem[];
}

export interface MetricItem {
  label: string;
  value: string;
  /** Optional subtle color hint. */
  color?: "default" | "success" | "warn" | "danger";
}

/** A list of status entries (e.g. per-repo status, capability list). */
export interface StatusListBlock extends UiBlockBase {
  type: "status-list";
  items: StatusItem[];
}

export interface StatusItem {
  label: string;
  status: "ok" | "warn" | "error" | "unknown";
  /** Optional secondary detail text. */
  detail?: string;
}

/** A list of safe external links. */
export interface LinkListBlock extends UiBlockBase {
  type: "link-list";
  items: LinkItem[];
}

export interface LinkItem {
  label: string;
  /** Only http/https URLs permitted after sanitization. */
  url: string;
}

/** Strict discriminated union of all known UI blocks. */
export type UiBlock =
  | NoticeBlock
  | MetricListBlock
  | StatusListBlock
  | LinkListBlock;

/* ------------------------------------------------------------------ */
/*  Provider state                                                     */
/* ------------------------------------------------------------------ */

export type ProviderState = "available" | "unavailable" | "degraded";

/* ------------------------------------------------------------------ */
/*  Provider contract                                                  */
/* ------------------------------------------------------------------ */

/**
 * A built-in, trusted integration provider.
 *
 * Instances are constructed via the registry and frozen. No provider code
 * originates from workspace files or node_modules plugins.
 */
export interface IntegrationProvider {
  /** Stable unique identifier (kebab-case, e.g. "built-in-graphify"). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** One-line description. */
  description: string;
  /** Capabilities this provider contributes. */
  capabilities: Capability[];
  /** Overall risk level. */
  riskLevel: RiskLevel;
  /** Tool descriptors (metadata only for 0.5.0). */
  tools: ToolDescriptor[];
  /**
   * Produce the UI blocks for this provider given the current context.
   * Return null / throw to signal unavailable/degraded.
   */
  getBlocks(ctx: WorkspaceIntegrationContext): UiBlock[] | Promise<UiBlock[]>;
  /**
   * Return the provider's current health state.
   * Defaults to "available" — override to detect missing dependencies.
   */
  getState?(ctx: WorkspaceIntegrationContext): ProviderState | Promise<ProviderState>;
}

/* ------------------------------------------------------------------ */
/*  Authoritative context (server-side only)                           */
/* ------------------------------------------------------------------ */

/**
 * Context constructed exclusively from authoritative server-side sources:
 *   - getOpenedWorkspaceFilePath(): absolute path to the .code-workspace file
 *   - getAllRepos(): registered repositories from the workspace scan
 *
 * NEVER populated from browser input.  No filesystem paths from clients.
 */
export interface WorkspaceIntegrationContext {
  /** Absolute path to the opened .code-workspace file. */
  workspaceFilePath: string;
  /** Display name of the workspace. */
  workspaceName: string;
  /** Registered repositories from the workspace scan. */
  repos: WorkspaceRepoInfo[];
}

/** Lightweight repo info for the integration context. */
export interface WorkspaceRepoInfo {
  /** Stable repository ID. */
  id: string;
  /** Absolute repo root path. */
  rootPath: string;
  /** Human-readable display name. */
  displayName: string;
}

/* ------------------------------------------------------------------ */
/*  Manifest (API response shape)                                      */
/* ------------------------------------------------------------------ */

/**
 * Per-provider entry in the workspace manifest.
 * Failures degrade to a compact entry — no exception strings or paths leaked.
 */
export interface ProviderManifestEntry {
  /** Provider ID. */
  id: string;
  /** Provider display name. */
  name: string;
  /** Provider description. */
  description: string;
  /** Current operational state. */
  state: ProviderState;
  /** Capabilities contributed. */
  capabilities: Capability[];
  /** Overall risk level. */
  riskLevel: RiskLevel;
  /** Tool descriptors. */
  tools: ToolDescriptor[];
  /** UI blocks for rendering. */
  blocks: UiBlock[];
  /** Safe error code when unavailable/degraded (never raw exception). */
  errorCode?: string;
  /** Safe error message (never exception stack or paths). */
  errorMessage?: string;
}

/** Top-level workspace manifest response. */
export interface WorkspaceManifest {
  /** Workspace display name. */
  workspaceName: string;
  /** Timestamp (ISO). */
  generatedAt: string;
  /** Provider entries, stable order. */
  providers: ProviderManifestEntry[];
}

/* ------------------------------------------------------------------ */
/*  Registry config                                                    */
/* ------------------------------------------------------------------ */

/** Configuration passed to the registry constructor. */
export interface IntegrationRegistryConfig {
  /** Ordered list of built-in provider instances. */
  providers: IntegrationProvider[];
}

/* ------------------------------------------------------------------ */
/*  Validation error                                                   */
/* ------------------------------------------------------------------ */

export class IntegrationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationValidationError";
  }
}

/**
 * Error class used by providers to signal they are unavailable
 * in the current context (deterministic, no message parsing).
 */
export class IntegrationProviderUnavailable extends Error {
  constructor(msg?: string) {
    super(msg ?? "Provider unavailable");
    this.name = "IntegrationProviderUnavailable";
  }
}
