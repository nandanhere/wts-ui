import type { GitlabDiscussionFixContext } from "../variants/local-workspace/gitlabDiscussionFixContext";

export const AGENT_FEEDBACK_REQUESTED_EVENT = "wts:agent-feedback-requested";
export const AGENT_FEEDBACK_RESULT_REQUESTED_EVENT = "wts:agent-feedback-result-requested";
export const AGENT_TASK_REQUESTED_EVENT = "wts:agent-task-requested";

/** A prepared agent request. WTS opens it as a draft. The user reviews it and sends it. */
export interface AgentTaskRequest {
  calloutId: string;
  label: string;
  body: string;
  selectedText?: string;
}

export function requestAgentTask(task: AgentTaskRequest): void {
  window.dispatchEvent(new CustomEvent(AGENT_TASK_REQUESTED_EVENT, { detail: task }));
}

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
    "wts:agent-task-requested": CustomEvent<AgentTaskRequest>;
  }
}
