import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { test as base, expect, type Page, type Route } from "@playwright/test";
import type { AgentConversation, SendAgentConversationMessageRequest } from "../../src/lib/agentConversations";
import type { AgentFeedbackShelf } from "../../src/lib/agentFeedbackDraft";
import { agentTurnDecisionsFixture, agentTurnDecisionFixture } from "../../src/test/agentTurnDecisionsFixture";
import type { RecordAgentTurnDecisionRequest } from "../../src/lib/agentTurnDecisions";
import { agentTurnChecksFixture, agentTurnRestoreFixture } from "../../src/test/agentTurnActionsFixture";
import type { AgentTurnChanges } from "../../src/lib/agentTurnChanges";

export const MR_CONVERSATION = "22222222-2222-4222-8222-222222222222";
export const ACTIVE_CONVERSATION = "33333333-3333-4333-8333-333333333333";
export const SELECTED_DRAFT = "44444444-4444-4444-8444-444444444444";
export const QUEUED_MESSAGE = "55555555-5555-4555-8555-555555555555";
export const ORIGINAL_MR_TASK = "Fix the original MR retry path.";
export const UNRELATED_DRAFT = "Keep this unrelated workspace-title draft.";
export const QUEUED_TASK = "Queued repository-label fix.";
const FAILED_MESSAGE = "66666666-6666-4666-8666-666666666666";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const SHELF_KEY = "wts.agent-feedback.shelf.v2";

const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<div id="feedback-fixture"></div>
<script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AgentFeedbackBubble} from '/src/components/AgentFeedbackBubble.tsx';
import {RepositoryPatchViewer} from '/src/variants/local-workspace/RepositoryPatchViewer.tsx';
import {createWorkspaceClient} from '/src/lib/wtsClient.ts';
import '/src/global.css';
const client = createWorkspaceClient({runtime:'http',baseUrl:window.location.origin});
const currentPatch = ${JSON.stringify("diff --git a/src/title.ts b/src/title.ts\n--- a/src/title.ts\n+++ b/src/title.ts\n@@ -1 +1 @@\n-export const currentCapture = 0;\n+export const currentCapture = 99;\n")};
const current = new URLSearchParams(location.search).has('changes') ? React.createElement('main',{style:{height:'100vh',width:'100vw'}},React.createElement(RepositoryPatchViewer,{patch:currentPatch,theme:'light'})) : null;
createRoot(document.getElementById('feedback-fixture')).render(React.createElement(React.Fragment,null,current,React.createElement(AgentFeedbackBubble,{client})));
</script></body></html>`;

export const test = base.extend<{}, { feedbackOrigin: string }>({
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await use(page);
    expect(errors, "The feedback fixture must not raise browser exceptions.").toEqual([]);
  },
  feedbackOrigin: [async ({}, use) => {
    const server = await createServer({
      configFile: false,
      root: fileURLToPath(new URL("../../", import.meta.url)),
      appType: "custom",
      cacheDir: "node_modules/.vite-feedback-e2e",
      plugins: [react(), {
        name: "isolated-feedback-browser-fixture",
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url?.split("?")[0] !== "/feedback-fixture") return next();
            void vite.transformIndexHtml("/feedback-fixture", html).then(result => {
              response.setHeader("Content-Type", "text/html"); response.end(result);
            }).catch(next);
          });
        },
      }],
      server: { host: "127.0.0.1", port: 0 },
      optimizeDeps: { include: ["react", "react-dom/client"] },
    });
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("The fixture server needs a local TCP port.");
    try { await use(`http://127.0.0.1:${address.port}`); }
    finally { await server.close(); }
  }, { scope: "worker" }],
});
export { expect };

function records(): AgentConversation[] {
  const mr: AgentConversation = {
    schemaVersion: 1, conversationId: MR_CONVERSATION, workspaceId: WORKSPACE,
    repositoryId: "repo-original-mr", workspaceDisplayPath: "/temporary/mr-workspace", provider: "codex",
    revision: 2, createdAtUnixMs: 1, updatedAtUnixMs: 2,
    source: { kind: "gitlabDiscussion", workspaceId: WORKSPACE, repositoryId: "repo-original-mr", providerRepositoryId: "gitlab-review-7", iid: 7,
      discussionId: "original-thread", scopeId: "a".repeat(64), filePath: "src/retry.ts", line: 21,
      comments: [{ id: 71, body: "Check the original retry path.", authorLogin: "reviewer", createdAt: "2026-09-18T00:00:00Z" }] },
    messages: [
      { messageId: "77777777-7777-4777-8777-777777777777", requestId: "original-mr-request", role: "user", body: ORIGINAL_MR_TASK, status: "failed", createdAtUnixMs: 1 },
      { messageId: FAILED_MESSAGE, requestId: "original-mr-request", role: "assistant", body: "", progress: "The provider inspected the original MR.\n".repeat(30),
        error: "The fixture provider timed out.", status: "failed", createdAtUnixMs: 2 },
    ],
  };
  const active: AgentConversation = {
    schemaVersion: 1, conversationId: ACTIVE_CONVERSATION, workspaceId: WORKSPACE,
    repositoryId: "repo-active", workspaceDisplayPath: "/temporary/active-workspace", provider: "codex",
    revision: 3, createdAtUnixMs: 10, updatedAtUnixMs: 12, activeSessionId: "active-fixture-session",
    source: { kind: "ui", route: "/fixture", calloutId: "workspace.repository", label: "Repository label" },
    messages: [
      { messageId: "active-user", requestId: "active-request", role: "user", body: "Active repository fix.", status: "running", createdAtUnixMs: 10, queueSequence: 1 },
      { messageId: "active-assistant", requestId: "active-request", role: "assistant", body: "", progress: "The fixture agent checks a repository.", status: "running", createdAtUnixMs: 11 },
      { messageId: QUEUED_MESSAGE, requestId: "queued-request", role: "user", body: QUEUED_TASK, submittedBody: QUEUED_TASK, status: "queued", createdAtUnixMs: 12, queueSequence: 2, queuePosition: 1 },
    ],
  };
  return [mr, active];
}

export interface SendCall { conversationId: string; request: SendAgentConversationMessageRequest }
export interface MutationCall { conversationId: string; messageId: string; action: "edit" | "cancel"; request: Record<string, unknown> }
export async function mountFeedback(page: Page, origin: string, options: { sendMode?: "immediate" | "deferred" | "loseOnce"; review?: AgentTurnChanges; withCurrentDiff?: boolean; reviewActions?: boolean; loseActionOnce?: "check" | "restore"; decisionMode?: "loseBefore" | "loseAfter" | "conflictOnce" } = {}) {
  const saved = new Map(records().map(item => [item.conversationId, item]));
  if (options.review) {
    const mr = saved.get(MR_CONVERSATION)!;
    mr.messages = mr.messages.map(message => ({ ...message, requestId: options.review!.requestId, sessionId: options.review!.sessionId }));
    mr.preview = { url: `${origin}/preview/original-mr`, repositoryId: mr.repositoryId };
    saved.get(ACTIVE_CONVERSATION)!.preview = { url: `${origin}/preview/other-task`, repositoryId: "repo-active" };
  }
  const actionCalls: Array<{ action: string; method: string; request?: Record<string, unknown> }> = [];
  const identity = options.review ? { conversationId: options.review.conversationId, requestId: options.review.requestId, sessionId: options.review.sessionId, workspaceId: options.review.workspaceId, repositoryId: options.review.repositoryId, afterCheckpointId: options.review.after?.checkpointId } : {};
  let decisions = agentTurnDecisionsFixture({ ...identity, ...(options.review ? { sourceContextSha256: options.review.sourceContextSha256 } : {}) });
  let decisionResponseLost = false;
  const checks = agentTurnChecksFixture(identity);
  const preflight = agentTurnRestoreFixture(identity);
  let lost = false;
  const reviewReads: Array<{ conversationId: string; requestId: string }> = [];
  const sends: SendCall[] = []; const mutations: MutationCall[] = []; const unexpected: string[] = [];
  let release: (() => void) | undefined;
  let counter = 0;
  const selectedSource = { kind: "ui" as const, route: "/fixture", calloutId: "workspace.title", label: "Workspace title" };
  const shelf: AgentFeedbackShelf = { version: 2, open: true, selectedId: SELECTED_DRAFT,
    drafts: [{ version: 1, id: SELECTED_DRAFT, open: true, body: UNRELATED_DRAFT,
      request: { requestId: "88888888-8888-4888-8888-888888888888", provider: "codex", source: selectedSource } }] };
  await page.addInitScript(({ key, value }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(value));
  }, { key: SHELF_KEY, value: shelf });
  const fulfill = (route: Route, value: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()); const method = route.request().method();
    if (url.pathname === "/api/v1/bootstrap" && method === "GET") return fulfill(route, { sessionToken: "isolated-browser-fixture-token" });
    expect(route.request().headers()["x-wts-session"]).toBe("isolated-browser-fixture-token");
    if (url.pathname === "/api/v1/agent-conversations" && method === "GET") return fulfill(route, { schemaVersion: 1, conversations: [...saved.values()] });
    const reviewTarget = url.pathname.match(/^\/api\/v1\/agent-conversations\/([^/]+)\/messages\/([^/]+)\/changes$/);
    if (reviewTarget && method === "GET" && options.review) {
      const ids = { conversationId: decodeURIComponent(reviewTarget[1]), requestId: decodeURIComponent(reviewTarget[2]) };
      expect(ids).toEqual({ conversationId: options.review.conversationId, requestId: options.review.requestId });
      reviewReads.push(ids); return fulfill(route, options.review);
    }
    const decisionTarget = url.pathname.match(/^\/api\/v1\/agent-conversations\/([^/]+)\/messages\/([^/]+)\/decisions$/);
    if (decisionTarget && options.review) {
      expect([decisionTarget[1], decisionTarget[2]]).toEqual([options.review.conversationId, options.review.requestId]);
      if (method === "GET") return fulfill(route, decisions);
      const request = route.request().postDataJSON() as RecordAgentTurnDecisionRequest;
      actionCalls.push({ action: "decision", method, request: { ...request } });
      if (options.decisionMode === "loseBefore" && !decisionResponseLost) { decisionResponseLost = true; return route.abort("failed"); }
      if (options.decisionMode === "conflictOnce" && !decisionResponseLost) {
        decisionResponseLost = true;
        const earlier = { ...request, requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "kept" as const, reason: "An earlier review choice." };
        decisions = { ...decisions, revision: decisions.revision + 1, decisions: [...decisions.decisions, agentTurnDecisionFixture(earlier, { afterCheckpointId: decisions.afterCheckpointId, sourceContextSha256: decisions.sourceContextSha256 })] };
        return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "agent_conversation_conflict", message: "Another decision changed the history.", retryable: false } }) });
      }
      if (!decisions.decisions.some(decision => decision.decisionId === request.requestId)) {
        expect(request.expectedRevision).toBe(decisions.revision); expect(request.expectedReceiptDigest).toBe(decisions.receiptDigest);
        decisions = { ...decisions, revision: decisions.revision + 1, decisions: [...decisions.decisions, agentTurnDecisionFixture(request, { afterCheckpointId: decisions.afterCheckpointId, sourceContextSha256: decisions.sourceContextSha256, checksState: "stale", checks: [{ runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", checkId: "unit", status: "failed" }] })] };
      }
      if (options.decisionMode === "loseAfter" && !decisionResponseLost) { decisionResponseLost = true; return route.abort("failed"); }
      return fulfill(route, decisions);
    }
    const actionTarget = url.pathname.match(/^\/api\/v1\/agent-conversations\/([^/]+)\/messages\/([^/]+)\/(checks|restore-preflight|restore)$/);
    if (actionTarget && options.reviewActions && options.review) {
      expect([actionTarget[1], actionTarget[2]]).toEqual([options.review.conversationId, options.review.requestId]);
      const action = actionTarget[3]; const request = method === "POST" ? route.request().postDataJSON() : undefined;
      actionCalls.push({ action, method, request });
      if (method === "GET") return fulfill(route, action === "checks" ? checks : preflight);
      if (!lost && ((action === "checks" && options.loseActionOnce === "check") || (action === "restore" && options.loseActionOnce === "restore"))) { lost = true; return route.abort("failed"); }
      if (action === "checks") {
        expect(request).toMatchObject({ checkId: "unit", expectedAfterCheckpointId: options.review.after!.checkpointId, expectedPlanRevision: 1 });
        if (!checks.runs.some(run => run.runId === request.requestId)) checks.runs.push({ runId: request.requestId, checkId: request.checkId, status: "failed", startedAtUnixMs: 1, completedAtUnixMs: 2, durationMs: 1, exitCode: 1, output: "Expected title: Workspace\nActual title: Untitled", outputTruncated: false, detail: "The title test failed." });
        return fulfill(route, checks);
      }
      expect(request.effectDigest).toBe(preflight.effectDigest);
      preflight.state = "restored";
      return fulfill(route, { schemaVersion: 1, conversationId: options.review.conversationId, requestId: options.review.requestId, restoreRequestId: request.requestId, state: "restored", restoredAtUnixMs: 5, files: preflight.files, blockers: [], detail: "WTS restored the listed files." });
    }
    const target = url.pathname.match(/^\/api\/v1\/agent-conversations\/([^/]+)(?:\/messages(?:\/([^/]+)(\/cancel)?)?)?$/);
    if (!target) { unexpected.push(`${method} ${url.pathname}`); return route.fulfill({ status: 404, body: "{}" }); }
    const id = decodeURIComponent(target[1]); const current = saved.get(id);
    if (!current) { unexpected.push(`${method} unknown conversation`); return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "agent_conversation_not_found", message: "The fixture task was not found.", retryable: false } }) }); }
    if (method === "GET") return fulfill(route, current);
    if (method === "POST" && !target[2]) {
      const request = route.request().postDataJSON() as SendAgentConversationMessageRequest;
      sends.push({ conversationId: id, request });
      if (options.sendMode === "loseOnce" && sends.length === 1) return route.abort("failed");
      if (options.sendMode === "deferred" && sends.length === 1) await new Promise<void>(resolve => { release = resolve; });
      const latest = saved.get(id)!;
      if (latest.messages.some(message => message.role === "user" && message.requestId === request.requestId)) return fulfill(route, latest);
      const next: AgentConversation = { ...latest, revision: latest.revision + 1, updatedAtUnixMs: 20 + ++counter,
        messages: [...latest.messages, { messageId: `new-request-${counter}`, requestId: request.requestId, submittedBody: request.body, role: "user", body: request.body, status: "queued", queuePosition: 2, queueSequence: 10 + counter, createdAtUnixMs: 20 + counter }] };
      saved.set(id, next); return fulfill(route, next);
    }
    if ((method === "PATCH" || method === "POST") && target[2]) {
      const request = route.request().postDataJSON(); const messageId = decodeURIComponent(target[2]);
      const cancel = Boolean(target[3]); mutations.push({ conversationId: id, messageId, action: cancel ? "cancel" : "edit", request });
      const message = current.messages.find(message => message.messageId === messageId)!;
      expect(request.expectedBody).toBe(message.body);
      const next: AgentConversation = { ...current, revision: current.revision + 1, messages: current.messages.map(item => item.messageId === messageId
        ? { ...item, body: cancel ? item.body : request.body, status: cancel ? "cancelled" : "queued", queuePosition: cancel ? undefined : item.queuePosition, lastMutationRequestId: request.requestId } : item) };
      saved.set(id, next); return fulfill(route, next);
    }
    unexpected.push(`${method} ${url.pathname}`); return route.fulfill({ status: 405, body: "{}" });
  });
  await page.goto(`${origin}/feedback-fixture${options.withCurrentDiff ? "?changes=1" : ""}`);
  await expect(page.getByRole("dialog", { name: "Agent feedback" })).toBeVisible();
  return { sends, mutations, unexpected, saved, reviewReads, actionCalls, release: () => release?.(),
    shelf: () => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SHELF_KEY) as Promise<AgentFeedbackShelf> };
}
