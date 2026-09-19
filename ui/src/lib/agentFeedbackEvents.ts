import type { GitlabDiscussionFixContext } from "../variants/local-workspace/gitlabDiscussionFixContext";

export const AGENT_FEEDBACK_REQUESTED_EVENT = "wts:agent-feedback-requested";
export const AGENT_FEEDBACK_RESULT_REQUESTED_EVENT = "wts:agent-feedback-result-requested";

export interface AgentFeedbackResultTarget {
  conversationId: string;
  requestId: string;
  messageId?: string;
}

export function openAgentFeedbackResult(target: AgentFeedbackResultTarget): void {
  window.dispatchEvent(new CustomEvent(AGENT_FEEDBACK_RESULT_REQUESTED_EVENT, { detail: target }));
}

export function openAgentFeedback(source: GitlabDiscussionFixContext): void {
  window.dispatchEvent(new CustomEvent(AGENT_FEEDBACK_REQUESTED_EVENT, { detail: source }));
}

declare global {
  interface WindowEventMap {
    "wts:agent-feedback-requested": CustomEvent<GitlabDiscussionFixContext>;
    "wts:agent-feedback-result-requested": CustomEvent<AgentFeedbackResultTarget>;
  }
}
