/**
 * Tests for IntegrationRegistry — validation, immutability, approval invariant.
 *
 * Run: node --experimental-strip-types --loader ../../../scripts/register-ts.mjs \
 *       --test src/lib/integrations/__tests__/registry.test.ts
 */

import { describe, it } from "node:test";
import { ok, strictEqual, throws } from "node:assert";
import { IntegrationRegistry } from "../registry";
import { IntegrationValidationError } from "../types";
import type { IntegrationProvider } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeProvider(overrides: Partial<IntegrationProvider> = {}): IntegrationProvider {
  return {
    id: "test-provider",
    name: "Test Provider",
    description: "A test provider.",
    capabilities: ["context"],
    riskLevel: "readonly",
    tools: [],
    getBlocks: () => [],
    getState: () => "available",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

void describe("IntegrationRegistry.create", () => {
  void it("creates a registry with valid providers", () => {
    const reg = IntegrationRegistry.create({ providers: [makeProvider()] });
    strictEqual(reg.size, 1);
    ok(reg.get("test-provider"));
  });

  void it("rejects duplicate provider IDs", () => {
    throws(
      () =>
        IntegrationRegistry.create({
          providers: [makeProvider({ id: "dup" }), makeProvider({ id: "dup" })],
        }),
      IntegrationValidationError
    );
  });

  void it("rejects empty id", () => {
    throws(
      () =>
        IntegrationRegistry.create({
          providers: [makeProvider({ id: "" })],
        }),
      IntegrationValidationError
    );
  });

  void it("rejects non-kebab-case id", () => {
    throws(
      () =>
        IntegrationRegistry.create({
          providers: [makeProvider({ id: "Invalid_ID" })],
        }),
      IntegrationValidationError
    );
  });

  void it("rejects empty name", () => {
    throws(
      () =>
        IntegrationRegistry.create({
          providers: [makeProvider({ name: "" })],
        }),
      IntegrationValidationError
    );
  });

  void it("rejects invalid capability", () => {
    throws(
      () =>
        IntegrationRegistry.create({
          providers: [makeProvider({ capabilities: ["invalid-cap"] })],
        }),
      IntegrationValidationError
    );
  });

  void it("rejects invalid riskLevel", () => {
    throws(
      () =>
        IntegrationRegistry.create({
          providers: [makeProvider({ riskLevel: "extreme" as any })],
        }),
      IntegrationValidationError
    );
  });

  void it("rejects missing getBlocks", () => {
    throws(
      () =>
        IntegrationRegistry.create({
              providers: [{ ...makeProvider(), getBlocks: undefined } as any],
        }),
      IntegrationValidationError
    );
  });

  void it("rejects non-function getState", () => {
    throws(
      () =>
        IntegrationRegistry.create({
          providers: [
            { ...makeProvider(), getState: "available" } as unknown as IntegrationProvider,
          ],
        }),
      /getState must be a function/
    );
  });

  void it("rejects oversized provider and tool descriptors", () => {
    throws(
      () =>
        IntegrationRegistry.create({
          providers: [makeProvider({ name: "n".repeat(121) })],
        }),
      /name is too long/
    );
    throws(
      () =>
        IntegrationRegistry.create({
          providers: [
            makeProvider({
              tools: [
                {
                  id: "read-tool",
                  label: "l".repeat(121),
                  description: "Read-only tool",
                  requiresApproval: false,
                  risk: "readonly",
                },
              ],
            }),
          ],
        }),
      /label is too long/
    );
  });

  void it("freezes the provider list", () => {
    const reg = IntegrationRegistry.create({ providers: [makeProvider()] });
    // Verify it's a frozen array
    strictEqual(Object.isFrozen(reg.providers as unknown as object), true);
  });

  void it("get() returns undefined for unknown ID", () => {
    const reg = IntegrationRegistry.create({ providers: [makeProvider()] });
    strictEqual(reg.get("nonexistent"), undefined);
  });

  void it("rejects duplicate capabilities within a provider", () => {
    throws(
      () =>
        IntegrationRegistry.create({
          providers: [
            makeProvider({
              capabilities: ["context", "context"],
            }),
          ],
        }),
      IntegrationValidationError
    );
  });

  void it("rejects duplicate tool IDs within a provider", () => {
    throws(
      () =>
        IntegrationRegistry.create({
          providers: [
            makeProvider({
              tools: [
                {
                  id: "dup-tool",
                  label: "Tool A",
                  description: "First occurrence",
                  requiresApproval: false,
                  risk: "readonly",
                },
                {
                  id: "dup-tool",
                  label: "Tool B",
                  description: "Duplicate ID",
                  requiresApproval: false,
                  risk: "readonly",
                },
              ],
            }),
          ],
        }),
      IntegrationValidationError
    );
  });

  void it("deep-freezes provider, tools, and capabilities arrays", () => {
    const reg = IntegrationRegistry.create({
      providers: [
        makeProvider({
          capabilities: ["context", "metrics"],
          tools: [
            {
              id: "deep-freeze-tool",
              label: "Frozen Tool",
              description: "Should be frozen",
              requiresApproval: false,
              risk: "readonly",
            },
          ],
        }),
      ],
    });

    const provider = reg.get("test-provider")!;

    // Provider itself should be frozen
    strictEqual(Object.isFrozen(provider), true);

    // Capabilities array should be frozen
    strictEqual(Object.isFrozen(provider.capabilities), true);

    // Tools array should be frozen
    strictEqual(Object.isFrozen(provider.tools), true);

    // Each tool descriptor should be frozen
    for (const tool of provider.tools) {
      strictEqual(Object.isFrozen(tool), true);
    }
  });
});

void describe("Original input immutability", () => {
  void it("original input remains mutable after registry construction", () => {
    const inputProvider = makeProvider({
      capabilities: ["context", "metrics"],
      tools: [
        {
          id: "tool-a",
          label: "Tool A",
          description: "Original",
          requiresApproval: false,
          risk: "readonly",
        },
      ],
    });

    const reg = IntegrationRegistry.create({ providers: [inputProvider] });
    const stored = reg.get("test-provider")!;

    // Mutate original — registry must NOT be affected
    inputProvider.name = "Mutated";
    (inputProvider.capabilities as string[]).push("diagnostics");
    inputProvider.tools.push({
      id: "tool-b",
      label: "Tool B",
      description: "Added after",
      requiresApproval: false,
      risk: "readonly",
    });

    strictEqual(stored.name, "Test Provider", "Registry name should be unchanged");
    strictEqual(stored.capabilities.length, 2, "Registry capabilities length should be unchanged");
    strictEqual(stored.tools.length, 1, "Registry tools length should be unchanged");
  });

  void it("returned provider data is deeply frozen", () => {
    const reg = IntegrationRegistry.create({
      providers: [
        makeProvider({
          capabilities: ["context"],
          tools: [
            {
              id: "frozen-tool",
              label: "Frozen",
              description: "Frozen description",
              requiresApproval: false,
              risk: "readonly",
            },
          ],
        }),
      ],
    });

    const provider = reg.get("test-provider")!;

    // Provider itself must be frozen
    ok(Object.isFrozen(provider), "Provider should be frozen");

    // Capabilities array must be frozen
    ok(Object.isFrozen(provider.capabilities), "Capabilities should be frozen");

    // Tools array must be frozen
    ok(Object.isFrozen(provider.tools), "Tools should be frozen");

    // Each tool must be frozen
    for (const tool of provider.tools) {
      ok(Object.isFrozen(tool), "Each tool should be frozen");
    }

    // Mutations should throw in strict mode
    throws(() => {
      (provider as Record<string, unknown>).name = "Override";
    });
  });

  void it("getState is preserved as a function when present", () => {
    const getStateFn = () => "available" as const;
    const provider: IntegrationProvider = {
      ...makeProvider(),
      getState: getStateFn,
    };
    const reg = IntegrationRegistry.create({ providers: [provider] });
    const stored = reg.get("test-provider")!;
    strictEqual(typeof stored.getState, "function", "getState must be a function");
    // Function reference must be preserved (not cloned)
    strictEqual(stored.getState, getStateFn);
  });

  void it("provider returns proper count", () => {
    const reg = IntegrationRegistry.create({
      providers: [makeProvider({ id: "p1" }), makeProvider({ id: "p2" })],
    });
    strictEqual(reg.size, 2);
    strictEqual(reg.providers.length, 2);
  });

  void it("accepts tool descriptors at the configured length limits", () => {
    const reg = IntegrationRegistry.create({
      providers: [
        makeProvider({
          tools: [
            {
              id: "a".repeat(80),
              label: "A".repeat(120),
              description: "B".repeat(300),
              requiresApproval: false,
              risk: "readonly",
            },
          ],
        }),
      ],
    });

    const provider = reg.get("test-provider")!;
    const tool = provider.tools[0];
    strictEqual(tool.id.length, 80);
    strictEqual(tool.label.length, 120);
    strictEqual(tool.description.length, 300);
  });

  void it("rejects duplicate tool IDs within a provider", () => {
    throws(
      () =>
        IntegrationRegistry.create({
          providers: [
            makeProvider({
              tools: [
                {
                  id: "dup-tool",
                  label: "Tool A",
                  description: "First occurrence",
                  requiresApproval: false,
                  risk: "readonly",
                },
                {
                  id: "dup-tool",
                  label: "Tool B",
                  description: "Duplicate ID",
                  requiresApproval: false,
                  risk: "readonly",
                },
              ],
            }),
          ],
        }),
      IntegrationValidationError
    );
  });

  void it("BUILT_IN_PROVIDERS array is frozen", async () => {
    const { BUILT_IN_PROVIDERS } = await import("../providers/index");
    ok(Object.isFrozen(BUILT_IN_PROVIDERS), "BUILT_IN_PROVIDERS must be frozen");
    const prevLen = BUILT_IN_PROVIDERS.length;
    try {
      (BUILT_IN_PROVIDERS as unknown[]).push({} as never);
    } catch {
      // Expected in strict mode
    }
    strictEqual(BUILT_IN_PROVIDERS.length, prevLen, "Array length must be unchanged");
  });
});

void describe("Approval invariant", () => {
  void it("accepts readonly tools without explicit approval", () => {
    const provider = makeProvider({
      tools: [
        {
          id: "read-tool",
          label: "Read",
          description: "A read-only tool",
          requiresApproval: false,
          risk: "readonly",
        },
      ],
    });
    const reg = IntegrationRegistry.create({ providers: [provider] });
    strictEqual(reg.size, 1);
  });

  void it("rejects low-risk tool without approval", () => {
    throws(
      () =>
        IntegrationRegistry.create({
          providers: [
            makeProvider({
              tools: [
                {
                  id: "low-risk-tool",
                  label: "Low Risk",
                  description: "A low risk tool",
                  requiresApproval: false,
                  risk: "low",
                },
              ],
            }),
          ],
        }),
      /requiresApproval/
    );
  });

  void it("rejects medium-risk tool without approval", () => {
    throws(
      () =>
        IntegrationRegistry.create({
          providers: [
            makeProvider({
              tools: [
                {
                  id: "med-risk-tool",
                  label: "Medium Risk",
                  description: "A medium risk tool",
                  requiresApproval: false,
                  risk: "medium",
                },
              ],
            }),
          ],
        }),
      /requiresApproval/
    );
  });

  void it("rejects high-risk tool without approval", () => {
    throws(
      () =>
        IntegrationRegistry.create({
          providers: [
            makeProvider({
              tools: [
                {
                  id: "high-risk-tool",
                  label: "High Risk",
                  description: "A high risk tool",
                  requiresApproval: false,
                  risk: "high",
                },
              ],
            }),
          ],
        }),
      /requiresApproval/
    );
  });

  void it("accepts non-readonly tools with approval", () => {
    const provider = makeProvider({
      tools: [
        {
          id: "write-tool",
          label: "Write",
          description: "A write tool with approval",
          requiresApproval: true,
          risk: "high",
        },
      ],
    });
    const reg = IntegrationRegistry.create({ providers: [provider] });
    strictEqual(reg.size, 1);
  });
});
