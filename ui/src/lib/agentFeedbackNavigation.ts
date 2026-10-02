import type { AgentConversation, AgentConversationSource } from "./agentConversations";

export const RETURN_FEEDBACK_SELECTION_EVENT = "wts:return-feedback-selection";
export interface FeedbackSelectionReturn {
  requestId: string;
  source: AgentConversationSource;
}

export async function resolveFeedbackSelectionOrigin(
  source: AgentConversationSource,
  load: (conversationId: string) => Promise<AgentConversation>,
): Promise<AgentConversationSource> {
  let current = source;
  const visited = new Set<string>();
  while (current.kind === "workItem") {
    const { originConversationId, originRequestId } = current;
    const key = `${originConversationId}:${originRequestId}`;
    if (visited.has(key) || visited.size >= 8) throw new Error("The saved task origin is not valid.");
    visited.add(key);
    const conversation = await load(originConversationId);
    if (conversation.conversationId !== originConversationId ||
      !conversation.messages.some(message => message.requestId === originRequestId && message.role === "user") ||
      !conversation.messages.some(message => message.requestId === originRequestId && message.role === "assistant")) {
      throw new Error("The saved task origin does not match this result.");
    }
    current = conversation.source;
  }
  return current;
}

export function returnToFeedbackSelection(source: AgentConversationSource): void {
  window.dispatchEvent(new CustomEvent<FeedbackSelectionReturn>(RETURN_FEEDBACK_SELECTION_EVENT, {
    detail: { requestId: crypto.randomUUID(), source },
  }));
}

/** Wait for the requested region after navigation. Never activate its controls. */
export function highlightFeedbackSelection(
  calloutId: string,
  isCurrent: () => boolean,
  onMissing: () => void,
): () => void {
  const deadline = performance.now() + 3_000;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let target: HTMLElement | undefined;
  let addedTabIndex = false;
  let stopped = false;
  const cleanup = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    if (target) {
      delete target.dataset.feedbackReveal;
      if (addedTabIndex) target.removeAttribute("tabindex");
    }
  };
  const inspect = () => {
    if (stopped || !isCurrent()) { cleanup(); return; }
    target = Array.from(document.querySelectorAll<HTMLElement>("[data-ui]")).find(element => {
      if (element.dataset.ui !== calloutId || element.closest('[hidden], [inert], [aria-hidden="true"], [data-ui-context="exclude"]')) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    if (target) {
      target.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      target.dataset.feedbackReveal = "true";
      addedTabIndex = !target.hasAttribute("tabindex") && !target.matches("button, a[href], input, textarea, select");
      if (addedTabIndex) target.tabIndex = -1;
      target.focus({ preventScroll: true });
      timer = setTimeout(cleanup, 2_000);
    } else if (performance.now() >= deadline) {
      cleanup();
      onMissing();
    } else frame = requestAnimationFrame(inspect);
  };
  frame = requestAnimationFrame(inspect);
  return cleanup;
}
