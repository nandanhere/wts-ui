import { beforeEach, describe, expect, it } from "vitest";
import { cleanupFeedbackCaptures, FEEDBACK_DRAFT_KEY, newFeedbackDraft, readFeedbackDraft, readFeedbackShelf, saveFeedbackShelf, persistFeedbackCapture, hydrateFeedbackCapture, type FeedbackCaptureStorage } from "./agentFeedbackDraft";
import type { RegionCapture } from "./agentConversations";
const capture: RegionCapture = { mimeType: "image/png", dataUrl: "data:image/png;base64,YWJj", width: 1, height: 1 };
const source = { kind: "ui" as const, route: "/", calloutId: "plan.description", label: "Plan description" };
beforeEach(() => localStorage.clear());
describe("feedback draft shelf", () => {
  it("validates a durable retry origin and preserves it after acknowledgement", () => {
    const draft = { ...newFeedbackDraft(source), conversationId: "chat", retryOrigin: { conversationId: "chat", messageId: "failed-turn", requestId: "retry-id" } };
    const shelf = { version: 2 as const, open: true, selectedId: draft.id, drafts: [draft] };
    expect(saveFeedbackShelf(shelf)).toBe(true); expect(readFeedbackShelf()).toEqual(shelf);
    for (const field of ["conversationId", "messageId", "requestId"]) for (const value of ["", "x".repeat(513), "bad\0id", 42]) {
      expect(saveFeedbackShelf({ ...shelf, drafts: [{ ...draft, retryOrigin: { ...draft.retryOrigin, [field]: value } }] })).toBe(false);
    }
    expect(readFeedbackShelf()).toEqual(shelf);
  });
  it("preserves multiple drafts, selected context, and uncertain request IDs across reads", () => {
    const first = newFeedbackDraft(source, "First fix"); first.attempt = { requestId: "uncertain-request", body: "First fix" };
    const second = newFeedbackDraft({ ...source, calloutId: "workspace.title", label: "Workspace title" }, "Second fix");
    expect(saveFeedbackShelf({ version: 2, open: true, selectedId: second.id, drafts: [first, second] })).toBe(true);
    expect(readFeedbackShelf()).toEqual({ version: 2, open: true, selectedId: second.id, drafts: [first, second] });
    expect(readFeedbackDraft()?.body).toBe("Second fix");
  });
  it("keeps the legacy draft until its image is durable and migrates without inline image data", async () => {
    const legacy = newFeedbackDraft({ ...source, capture }, "Retain the image"); legacy.attempt = { requestId: "original-request", body: legacy.body };
    localStorage.setItem(FEEDBACK_DRAFT_KEY, JSON.stringify(legacy));
    const shelf = readFeedbackShelf(); expect(shelf.drafts[0]).toEqual(legacy);
    expect(saveFeedbackShelf(shelf)).toBe(false); expect(localStorage.getItem(FEEDBACK_DRAFT_KEY)).not.toBeNull();
    const records = new Map<string, RegionCapture>();
    const storage: FeedbackCaptureStorage = { put: async (id, image) => { records.set(id, image); }, get: async id => records.get(id) };
    const migrated = await persistFeedbackCapture(legacy, storage);
    expect(saveFeedbackShelf({ ...shelf, drafts: [migrated] })).toBe(true);
    expect(localStorage.getItem(FEEDBACK_DRAFT_KEY)).toBeNull();
    const restored = readFeedbackShelf().drafts[0]; expect(JSON.stringify(restored)).not.toContain(capture.dataUrl);
    expect(await hydrateFeedbackCapture(restored, storage)).toEqual(migrated);
    expect(restored.attempt?.requestId).toBe("original-request");
  });
  it("falls back to text for a new draft when image storage fails", async () => {
    const draft = newFeedbackDraft({ ...source, capture }, "Use the text");
    const storage: FeedbackCaptureStorage = { put: async () => { throw new Error("Full"); }, get: async () => undefined };
    const result = await persistFeedbackCapture(draft, storage);
    expect(result.request.source).not.toHaveProperty("capture");
    expect(result.captureNote).toMatch(/image.*text/i);
    expect(saveFeedbackShelf({ version: 2, open: true, selectedId: result.id, drafts: [result] })).toBe(true);
  });
  it("does not change an uncertain request source when image storage fails", async () => {
    const draft = newFeedbackDraft({ ...source, capture }, "Keep this exact source"); draft.attempt = { requestId: "pending", body: draft.body };
    const storage: FeedbackCaptureStorage = { put: async () => { throw new Error("Full"); }, get: async () => undefined };
    const result = await persistFeedbackCapture(draft, storage);
    expect(result).toEqual(draft);
    expect(saveFeedbackShelf({ version: 2, open: true, selectedId: result.id, drafts: [result] })).toBe(false);
  });
  it("preserves the prior shelf when the new shelf exceeds its limit", () => {
    const draft = newFeedbackDraft(source, "Keep this draft");
    const shelf = { version: 2 as const, open: true, selectedId: draft.id, drafts: [draft] };
    expect(saveFeedbackShelf(shelf)).toBe(true);
    expect(saveFeedbackShelf({ ...shelf, drafts: Array.from({ length: 65 }, () => newFeedbackDraft(source, "Another draft")) })).toBe(false);
    expect(readFeedbackShelf()).toEqual(shelf);
  });
  it("rejects duplicate IDs and a missing selected draft without replacing the valid shelf", () => {
    const draft = newFeedbackDraft(source, "Keep this draft"); const shelf = { version: 2 as const, open: true, selectedId: draft.id, drafts: [draft] };
    expect(saveFeedbackShelf(shelf)).toBe(true);
    expect(saveFeedbackShelf({ ...shelf, drafts: [draft, draft] })).toBe(false);
    expect(saveFeedbackShelf({ ...shelf, selectedId: "missing" })).toBe(false);
    expect(readFeedbackShelf()).toEqual(shelf);
  });
  it("deletes unused images while preserving images referenced by the durable shelf", async () => {
    const records = new Map<string, RegionCapture>([["orphan", capture]]);
    const storage: FeedbackCaptureStorage = { put: async (id, image) => { records.set(id, image); }, get: async id => records.get(id), keys: async () => [...records.keys()], remove: async id => { records.delete(id); } };
    const draft = await persistFeedbackCapture(newFeedbackDraft({ ...source, capture }, "Keep this image"), storage);
    saveFeedbackShelf({ version: 2, open: true, selectedId: draft.id, drafts: [draft] });
    await cleanupFeedbackCaptures(storage); expect([...records.keys()]).toEqual([draft.id]);
    saveFeedbackShelf({ version: 2, open: false, drafts: [] });
    await cleanupFeedbackCaptures(storage); expect(records.size).toBe(0);
  });
});
