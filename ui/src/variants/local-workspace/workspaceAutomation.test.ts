import { describe, expect, it, vi } from "vitest";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import {
  claimWorkspaceAutomation,
  defaultWorkspaceAutomation,
  loadWorkspaceAutomation,
  runWorkspaceCompletionAutomation,
  saveWorkspaceAutomation,
  workspaceCompletionIsRecent,
} from "./workspaceAutomation";

describe("workspace completion automation", () => {
  it("uses safe defaults and validates persisted preferences", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    expect(loadWorkspaceAutomation(storage)).toEqual(defaultWorkspaceAutomation);
    const preference = {
      ...defaultWorkspaceAutomation,
      automaticAgentReview: true,
      quietPeriodSeconds: 30,
    };
    expect(saveWorkspaceAutomation(preference, storage)).toBe(true);
    expect(loadWorkspaceAutomation(storage)).toEqual(preference);
  });

  it("claims each recent completion once", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(workspaceCompletionIsRecent(90, 100)).toBe(true);
    expect(workspaceCompletionIsRecent(100, 90)).toBe(false);
    expect(claimWorkspaceAutomation("workspace-1", 100, storage)).toBe(true);
    expect(claimWorkspaceAutomation("workspace-1", 100, storage)).toBe(false);
  });

  it("runs deterministic checks before an explicitly enabled agent review", async () => {
    const fake = fakeWorkspaceClient();
    const order: string[] = [];
    fake.runWorkspaceVerification.mockImplementation(async () => {
      order.push("verification");
      throw new Error("Checks failed to start");
    });
    fake.getWorkspaceEvidence.mockImplementation(async () => {
      order.push("evidence");
      return null;
    });
    fake.indexWorkspaceGraph.mockImplementation(async () => {
      order.push("graph");
      return {
        workspaceId: "workspace-1",
        status: "ready",
        graphDisplayPath: ".wts/graphify-out",
        detail: "Index available.",
        durationMs: 1,
      };
    });
    fake.runWorkspaceAgent.mockImplementation(async () => {
      order.push("agent");
      return {
        workspaceId: "workspace-1",
        provider: "codex",
        succeeded: true,
        output: "Review ready",
        durationMs: 1,
      };
    });

    await expect(
      runWorkspaceCompletionAutomation(fake.client, "workspace-1", "codex", {
        ...defaultWorkspaceAutomation,
        automaticAgentReview: true,
      }),
    ).resolves.toMatchObject({
      verification: "failed",
      agentReview: "completed",
    });
    expect(order).toEqual(["verification", "evidence", "graph", "agent"]);
    expect(fake.runWorkspaceAgent).toHaveBeenCalledWith(
      "workspace-1",
      "codex",
      expect.stringContaining("Suggest a review order"),
    );
  });

  it("does not start an agent when the opt-in is disabled", async () => {
    const fake = fakeWorkspaceClient();
    fake.runWorkspaceVerification.mockRejectedValue(new Error("Unavailable"));
    await runWorkspaceCompletionAutomation(
      fake.client,
      "workspace-1",
      "codex",
      defaultWorkspaceAutomation,
    );
    expect(fake.runWorkspaceAgent).not.toHaveBeenCalled();
  });
});
