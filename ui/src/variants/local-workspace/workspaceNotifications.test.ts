import { describe, expect, it } from "vitest";
import {
  markWorkspaceNotificationSent,
  notificationForWorkspaceAgent,
  notificationForWorkspaceVerification,
  workspaceNotificationWasSent,
} from "./workspaceNotifications";
import { workspaceEvidenceFixture } from "../../test/workspaceClientFake";

describe("workspace notifications", () => {
  it("creates useful completion and attention messages", () => {
    expect(
      notificationForWorkspaceAgent("Payments", {
        state: "idle",
        updateKind: "completion",
        activity: "Last task finished",
        latestUpdate: "The change is ready.",
        lastEventAtUnixMs: 100,
      }),
    ).toEqual({
      title: "Payments is ready for review",
      body: "The change is ready.",
    });
    expect(
      notificationForWorkspaceAgent("Payments", {
        state: "attention",
        activity: "Review the session",
        lastEventAtUnixMs: 101,
      }),
    ).toEqual({
      title: "Payments needs attention",
      body: "Review the session",
    });
    expect(
      notificationForWorkspaceAgent("Payments", {
        state: "working",
        activity: "Editing files…",
        lastEventAtUnixMs: 102,
      }),
    ).toBeNull();
  });

  it("uses fixed safe copy for questions and access requests", () => {
    expect(
      notificationForWorkspaceAgent("Payments", {
        state: "attention",
        needsInput: "question",
        activity: "Agent has a question.",
        lastEventAtUnixMs: 103,
      }),
    ).toEqual({
      title: "Payments needs your answer",
      body: "Agent has a question. Open WTS to review it.",
    });
    expect(
      notificationForWorkspaceAgent("Payments", {
        state: "attention",
        needsInput: "access",
        activity: "Agent needs access.",
        lastEventAtUnixMs: 104,
      }),
    ).toEqual({
      title: "Payments needs access",
      body: "Agent needs access. Open WTS to review the request.",
    });
  });

  it("records an event only after the notification effect succeeds", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(workspaceNotificationWasSent("workspace-1", 100, storage)).toBe(
      false,
    );
    expect(markWorkspaceNotificationSent("workspace-1", 100, storage)).toBe(
      true,
    );
    expect(workspaceNotificationWasSent("workspace-1", 100, storage)).toBe(
      true,
    );
    expect(workspaceNotificationWasSent("workspace-1", 99, storage)).toBe(
      true,
    );
    expect(workspaceNotificationWasSent("workspace-1", 101, storage)).toBe(
      false,
    );
  });

  it("describes the first failed verification check", () => {
    const evidence = workspaceEvidenceFixture();
    expect(notificationForWorkspaceVerification("Payments", evidence)).toEqual({
      title: "Payments verification failed",
      body: "Checkout unit tests: Expected one capture, received two.",
    });
    expect(
      notificationForWorkspaceVerification("Payments", {
        ...evidence,
        verificationResult: {
          ...evidence.verificationResult,
          status: "passed",
        },
      }),
    ).toBeNull();
  });
});
