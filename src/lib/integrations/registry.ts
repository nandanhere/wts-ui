/**
 * Integration registry — deterministic/immutable built-in provider registry.
 *
 * - Constructed via factory / constructor with a frozen list of providers.
 * - Rejects duplicate provider IDs.
 * - Rejects invalid descriptors (bad capability, non-readonly without approval).
 * - Not a mutable global — safe across Next.js bundles and hot reloads.
 */

import type {
  IntegrationProvider,
  IntegrationRegistryConfig,
  Capability,
  RiskLevel,
} from "./types";
import { IntegrationValidationError } from "./types";

/* ------------------------------------------------------------------ */
/*  Valid values                                                       */
/* ------------------------------------------------------------------ */

const VALID_CAPABILITIES: ReadonlySet<string> = new Set<Capability>([
  "context",
  "metrics",
  "diagnostics",
  "dependencies",
  "documentation",
  "reviews",
  "tools",
]);

const VALID_RISK_LEVELS: ReadonlySet<string> = new Set<RiskLevel>([
  "readonly",
  "low",
  "medium",
  "high",
]);

const TOOL_ID_RE = /^[a-z][a-z0-9-]*$/;
const MAX_PROVIDER_ID_LENGTH = 80;
const MAX_PROVIDER_NAME_LENGTH = 120;
const MAX_PROVIDER_DESCRIPTION_LENGTH = 300;
const MAX_CAPABILITIES = 20;
const MAX_TOOLS = 50;
const MAX_TOOL_ID_LENGTH = 80;
const MAX_TOOL_LABEL_LENGTH = 120;
const MAX_TOOL_DESCRIPTION_LENGTH = 300;

/* ------------------------------------------------------------------ */
/*  Validation helpers                                                 */
/* ------------------------------------------------------------------ */

function validateProvider(p: IntegrationProvider, index: number): void {
  const label = `provider[${index}] ("${p.id || "(missing)"}")`;

  if (typeof p.id !== "string" || p.id.length === 0) {
    throw new IntegrationValidationError(`${label}: id is required`);
  }
  if (!TOOL_ID_RE.test(p.id)) {
    throw new IntegrationValidationError(
      `${label}: id "${p.id}" must be lowercase kebab-case`
    );
  }
  if (p.id.length > MAX_PROVIDER_ID_LENGTH) {
    throw new IntegrationValidationError(`${label}: id is too long`);
  }

  if (typeof p.name !== "string" || p.name.length === 0) {
    throw new IntegrationValidationError(`${label}: name is required`);
  }
  if (p.name.length > MAX_PROVIDER_NAME_LENGTH) {
    throw new IntegrationValidationError(`${label}: name is too long`);
  }
  if (typeof p.description !== "string" || p.description.length === 0) {
    throw new IntegrationValidationError(`${label}: description is required`);
  }
  if (p.description.length > MAX_PROVIDER_DESCRIPTION_LENGTH) {
    throw new IntegrationValidationError(`${label}: description is too long`);
  }
  if (!Array.isArray(p.capabilities)) {
    throw new IntegrationValidationError(`${label}: capabilities must be an array`);
  }
  if (p.capabilities.length > MAX_CAPABILITIES) {
    throw new IntegrationValidationError(`${label}: too many capabilities`);
  }

  // Reject duplicate capabilities within a provider
  const seenCaps = new Set<string>();
  for (const cap of p.capabilities) {
    if (!VALID_CAPABILITIES.has(cap)) {
      throw new IntegrationValidationError(
        `${label}: unknown capability "${String(cap)}"`
      );
    }
    if (seenCaps.has(cap)) {
      throw new IntegrationValidationError(
        `${label}: duplicate capability "${cap}"`
      );
    }
    seenCaps.add(cap);
  }

  if (!VALID_RISK_LEVELS.has(p.riskLevel)) {
    throw new IntegrationValidationError(
      `${label}: invalid riskLevel "${p.riskLevel}"`
    );
  }
  if (typeof p.getBlocks !== "function") {
    throw new IntegrationValidationError(`${label}: getBlocks must be a function`);
  }
  if (p.getState !== undefined && typeof p.getState !== "function") {
    throw new IntegrationValidationError(
      `${label}: getState must be a function when provided`
    );
  }

  validateTools(p.tools, label);
}

function validateTools(
  tools: IntegrationProvider["tools"],
  label: string
): void {
  if (!Array.isArray(tools)) {
    throw new IntegrationValidationError(`${label}: tools must be an array`);
  }
  if (tools.length > MAX_TOOLS) {
    throw new IntegrationValidationError(`${label}: too many tools`);
  }

  // Reject duplicate tool IDs
  const seenToolIds = new Set<string>();

  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    const tLabel = `${label}.tools[${i}]`;

    if (typeof t.id !== "string" || t.id.length === 0) {
      throw new IntegrationValidationError(`${tLabel}: id is required`);
    }
    if (!TOOL_ID_RE.test(t.id)) {
      throw new IntegrationValidationError(
        `${tLabel}: id "${t.id}" must be lowercase kebab-case`
      );
    }
    if (t.id.length > MAX_TOOL_ID_LENGTH) {
      throw new IntegrationValidationError(`${tLabel}: id is too long`);
    }

    // Reject duplicate tool IDs
    if (seenToolIds.has(t.id)) {
      throw new IntegrationValidationError(
        `${tLabel}: duplicate tool id "${t.id}" within provider`
      );
    }
    seenToolIds.add(t.id);

    if (typeof t.label !== "string" || t.label.length === 0) {
      throw new IntegrationValidationError(`${tLabel}: label is required`);
    }
    if (t.label.length > MAX_TOOL_LABEL_LENGTH) {
      throw new IntegrationValidationError(`${tLabel}: label is too long`);
    }
    if (typeof t.description !== "string" || t.description.length === 0) {
      throw new IntegrationValidationError(`${tLabel}: description is required`);
    }
    if (t.description.length > MAX_TOOL_DESCRIPTION_LENGTH) {
      throw new IntegrationValidationError(`${tLabel}: description is too long`);
    }
    if (typeof t.requiresApproval !== "boolean") {
      throw new IntegrationValidationError(`${tLabel}: requiresApproval must be boolean`);
    }
    if (!VALID_RISK_LEVELS.has(t.risk)) {
      throw new IntegrationValidationError(
        `${tLabel}: invalid risk "${t.risk}"`
      );
    }

    // Approval invariant: any non-readonly tool MUST require explicit approval
    if (t.risk !== "readonly" && !t.requiresApproval) {
      throw new IntegrationValidationError(
        `${tLabel}: tool "${t.id}" has risk "${t.risk}" but requiresApproval is false. ` +
          "Non-readonly tools MUST require explicit approval."
      );
    }
  }
}

/**
 * Deep-clone then deep-freeze a provider, its arrays, and descriptors.
 * The clone ensures caller-owned objects/arrays are never mutated or frozen.
 * Function references (getBlocks, getState) are preserved by reference.
 */
function deepFreezeProvider(p: IntegrationProvider): IntegrationProvider {
  // Clone all mutable data; preserve function references
  const tools: IntegrationProvider["tools"] = p.tools.map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description,
    requiresApproval: t.requiresApproval,
    risk: t.risk,
  }));
  const capabilities = [...p.capabilities];

  // Freeze cloned arrays and descriptors
  for (const t of tools) {
    Object.freeze(t);
  }
  Object.freeze(tools);
  Object.freeze(capabilities);

  // Build a new frozen provider object — function refs preserved
  const cloned: IntegrationProvider = {
    id: p.id,
    name: p.name,
    description: p.description,
    capabilities,
    riskLevel: p.riskLevel,
    tools,
    getBlocks: p.getBlocks,
  };
  // Preserve optional getState if present
  if (typeof p.getState === "function") {
    (cloned as { getState?: typeof p.getState }).getState = p.getState;
  }

  return Object.freeze(cloned);
}

/* ------------------------------------------------------------------ */
/*  Registry class (immutable after construction)                      */
/* ------------------------------------------------------------------ */

export class IntegrationRegistry {
  private readonly _providers: ReadonlyArray<IntegrationProvider>;

  private constructor(providers: ReadonlyArray<IntegrationProvider>) {
    this._providers = providers;
  }

  /**
   * Create a registry, validating all providers.
   * Throws IntegrationValidationError on invalid input.
   * The provider list is frozen (shallow) after construction.
   */
  static create(config: IntegrationRegistryConfig): IntegrationRegistry {
    const { providers } = config;

    if (!Array.isArray(providers)) {
      throw new IntegrationValidationError("providers must be an array");
    }

    // Validate each provider
    for (let i = 0; i < providers.length; i++) {
      validateProvider(providers[i], i);
    }

    // Check for duplicate IDs
    const seen = new Set<string>();
    for (const p of providers) {
      if (seen.has(p.id)) {
        throw new IntegrationValidationError(
          `Duplicate provider id: "${p.id}"`
        );
      }
      seen.add(p.id);
    }

    // Deep-freeze each provider and freeze the list
    const frozen = Object.freeze(providers.map(deepFreezeProvider));

    return new IntegrationRegistry(frozen);
  }

  /** All registered providers (read-only). */
  get providers(): ReadonlyArray<IntegrationProvider> {
    return this._providers;
  }

  /** Look up a provider by ID. */
  get(id: string): IntegrationProvider | undefined {
    return this._providers.find((p) => p.id === id);
  }

  /** Number of registered providers. */
  get size(): number {
    return this._providers.length;
  }
}
