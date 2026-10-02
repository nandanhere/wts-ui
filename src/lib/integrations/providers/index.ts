/**
 * Built-in integration providers index.
 *
 * Add new built-in providers here. Do NOT import from workspace files
 * or node_modules plugins.
 */

import { graphifyProvider } from "./graphify";

/** Ordered list of all built-in trusted providers — frozen immutable. */
export const BUILT_IN_PROVIDERS = Object.freeze([graphifyProvider]);

/** Provider IDs for reference. */
export const BUILT_IN_PROVIDER_IDS = BUILT_IN_PROVIDERS.map((p) => p.id);
