# Integration Extension Model (v0.5.0)

## Trust Boundary

All integration provider code is **built-in** and loaded at registry construction time.

```
┌─────────────────────────────────────────┐
│              Browser / Client            │
│  No filesystem paths.                    │
│  Receives only sanitized manifest JSON.  │
└────────────────────┬────────────────────┘
                     │ GET /api/integrations
                     │ (same-origin required)
                     ▼
┌─────────────────────────────────────────┐
│           Server Route Handler           │
│  Builds context from:                    │
│    • getOpenedWorkspaceFilePath()        │
│    • getAllRepos()                       │
│  Constructs manifest.                    │
└──────────┬──────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│         IntegrationRegistry              │
│  Immutable. Frozen built-in providers.   │
│  No dynamic imports. No workspace code.  │
└─────────────────────────────────────────┘
```

**Key rules:**
- Browser input MUST NOT supply filesystem paths.
- Provider code is NEVER loaded from workspace files or `node_modules`.
- No dynamic `import()` / `eval()` — all providers are statically referenced.
- The registry is deterministic and immutable after construction.

---

## Contract

### `IntegrationProvider`

Every provider implements this interface:

```ts
interface IntegrationProvider {
  id: string;             // kebab-case stable identifier
  name: string;           // Human-readable display name
  description: string;    // One-line description
  capabilities: Capability[];
  riskLevel: RiskLevel;
  tools: ToolDescriptor[]; // Metadata only (0.5.0)
  getBlocks(ctx: WorkspaceIntegrationContext): UiBlock[] | Promise<UiBlock[]>;
  getState?(ctx: WorkspaceIntegrationContext): ProviderState | Promise<ProviderState>;
}
```

### `WorkspaceIntegrationContext`

Constructed server-side from authoritative sources:

```ts
interface WorkspaceIntegrationContext {
  workspaceFilePath: string;  // Absolute .code-workspace path
  workspaceName: string;
  repos: WorkspaceRepoInfo[]; // Registered repos only
}
```

### Schema

#### Capabilities

| Value            | Description                           |
|------------------|---------------------------------------|
| `context`        | Workspace & repository context        |
| `metrics`        | Aggregated metrics                    |
| `diagnostics`    | Error/warning diagnostics             |
| `dependencies`   | Cross-repository dependency analysis  |
| `documentation`  | Repository documentation/wiki         |
| `reviews`        | Code review integration               |
| `tools`          | Provides executable tools             |

#### Risk Levels

| Level      | Description                           |
|------------|---------------------------------------|
| `readonly` | No state change, no side effects      |
| `low`      | Minor side effects (e.g. cache write) |
| `medium`   | Noticeable side effects               |
| `high`     | Destructive or mutating operations    |

#### Tool Descriptors (Metadata Only)

```ts
interface ToolDescriptor {
  id: string;               // kebab-case
  label: string;
  description: string;
  requiresApproval: boolean; // True for any non-readonly tool
  risk: RiskLevel;
}
```

**Invariant:** Any tool with `risk !== "readonly"` MUST have `requiresApproval: true`. The registry enforces this at construction time.

#### UI Blocks (Discriminated Union)

| Type            | Fields                                                   | Bounds            |
|-----------------|----------------------------------------------------------|-------------------|
| `notice`        | `id`, `title`, `message`, `severity?`                    | message ≤ 500     |
| `metric-list`   | `id`, `title`, `items: {label, value, color?}[]`        | items ≤ 20        |
| `status-list`   | `id`, `title`, `items: {label, status, detail?}[]`      | items ≤ 50        |
| `link-list`     | `id`, `title`, `items: {label, url}[]`                  | items ≤ 20. Http/https only |

Each provider response is capped at 20 blocks. A manifest is capped at 20
providers. Provider declarations are also bounded to 20 capabilities and 50
tool descriptors. Provider and tool labels/descriptions have fixed length
limits enforced when the registry is constructed.

**No** `Record<string, unknown>`, raw HTML, JSX strings, `dangerouslySetInnerHTML`, arbitrary component names, scripts, or arbitrary payloads.

---

## Lifecycle

1. **Registry construction** — `IntegrationRegistry.create()` validates all providers, clones their descriptors, and deeply freezes the registry-owned copies without freezing caller-owned values.
2. **Context building** — Server route handler builds `WorkspaceIntegrationContext` from `getOpenedWorkspaceFilePath()` and `getAllRepos()`.
3. **Manifest generation** — `buildManifest()` iterates providers, calls `getState()` then `getBlocks()`, sanitizes output.
4. **Response** — Sanitized JSON manifest returned to client.

### Graceful Degradation

If a provider throws or returns `unavailable` state:
- A compact `unavailable` entry is produced.
- A safe `errorCode` and `errorMessage` are included (no exception strings, no paths).
- The `blocks` array contains a single safe `notice` block.

---

## Approval Rules

- `readonly` tools: explicit approval is optional.
- `low`, `medium`, `high` tools: `requiresApproval` MUST be `true`.
- The registry's validation enforces this at construction time.
- The client should gate non-readonly tool invocations behind explicit user confirmation.

---

## Adding a Built-in Provider

1. Create a new file in `src/lib/integrations/providers/<name>.ts`.
2. Implement the `IntegrationProvider` contract.
3. Add the provider to the `BUILT_IN_PROVIDERS` array in `src/lib/integrations/providers/index.ts`.
4. Add tests in `src/lib/integrations/__tests__/`.
5. Run the test suite: `npm test`.

### Example

```ts
// src/lib/integrations/providers/my-provider.ts
import type { IntegrationProvider, WorkspaceIntegrationContext, UiBlock } from "../types";

export const myProvider: IntegrationProvider = {
  id: "my-integration",
  name: "My Integration",
  description: "Provides custom metrics.",
  capabilities: ["metrics"],
  riskLevel: "readonly",
  tools: [],
  getBlocks(ctx: WorkspaceIntegrationContext): UiBlock[] {
    return [
      {
        type: "metric-list",
        id: "my-metrics",
        title: "Custom Metrics",
        items: [
          { label: "Total repos", value: String(ctx.repos.length) },
        ],
      },
    ];
  },
};
```

Then add to `providers/index.ts`:

```ts
import { myProvider } from "./my-provider";
export const BUILT_IN_PROVIDERS = Object.freeze([graphifyProvider, myProvider]);
```

---

## Not Supported Yet (v0.5.0)

- **Workspace manifests** (arbitrary JSON from workspace files)
- **Dynamic code from workspace files** (plugins, custom providers from repos)
- **Tool execution** (tool descriptors are metadata-only for now)
- **LLM/MR clients**
- **"Unify" or unspecified external integrations**

These are explicitly out of scope for 0.5.0. The registry validates strictly to prevent accidental misuse.
