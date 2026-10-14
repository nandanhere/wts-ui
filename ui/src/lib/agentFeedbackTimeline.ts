import type { AgentConversation, AgentConversationMessage } from "./agentConversations";

export interface FeedbackTimelineRow {
  key: string;
  conversation: AgentConversation;
  message: AgentConversationMessage;
  request?: AgentConversationMessage;
}

interface Turn {
  key: string;
  timestamp: number;
  responseTimestamp?: number;
  rows: FeedbackTimelineRow[];
}

export function buildFeedbackTimeline(conversations: readonly AgentConversation[]): {
  timeline: FeedbackTimelineRow[];
  queued: FeedbackTimelineRow[];
} {
  const turns: Turn[] = [];
  const queues = new Map<string, FeedbackTimelineRow[]>();
  for (const conversation of conversations) {
    const users = conversation.messages.filter(message => message.role === "user");
    const byRequest = new Map(users.filter(message => message.requestId).map(message => [message.requestId, message]));
    const bySession = new Map(users.filter(message => message.sessionId).map(message => [message.sessionId, message]));
    const localTurns = new Map<string, Turn>();
    let precedingUser: AgentConversationMessage | undefined;
    for (const message of conversation.messages) {
      if (message.role === "user") precedingUser = message;
      const request = message.role === "user" ? message : message.role === "assistant"
        ? message.requestId ? byRequest.get(message.requestId)
          : message.sessionId ? bySession.get(message.sessionId) ?? precedingUser : precedingUser
        : undefined;
      const key = `${conversation.conversationId}/${message.messageId}`;
      const row = { key, conversation, message, request };
      if (message.role === "user" && message.status === "queued") {
        const queue = queues.get(conversation.workspaceId) ?? [];
        queue.push(row);
        queues.set(conversation.workspaceId, queue);
        continue;
      }
      if (request?.status === "queued") continue;
      const turnKey = `${conversation.conversationId}/${request?.messageId ?? message.messageId}`;
      let turn = localTurns.get(turnKey);
      if (!turn) {
        turn = { key: turnKey, timestamp: request?.createdAtUnixMs ?? message.createdAtUnixMs, rows: [] };
        localTurns.set(turnKey, turn);
        turns.push(turn);
      }
      if (request && message.role === "assistant") {
        turn.responseTimestamp = Math.min(turn.responseTimestamp ?? Infinity, message.createdAtUnixMs);
      }
      turn.rows.push(row);
    }
  }
  // A queued request enters the transcript at dispatch, beside its eventual reply.
  turns.sort((a, b) => (a.responseTimestamp ?? a.timestamp) - (b.responseTimestamp ?? b.timestamp) || a.key.localeCompare(b.key));
  const orderedQueues = [...queues.values()].sort((a, b) =>
    Math.min(...a.map(row => row.message.createdAtUnixMs)) - Math.min(...b.map(row => row.message.createdAtUnixMs)) ||
    a[0].conversation.workspaceId.localeCompare(b[0].conversation.workspaceId));
  const queued = orderedQueues.flatMap(queue => queue.sort((a, b) =>
    (a.message.queuePosition ?? a.message.queueSequence ?? Infinity) - (b.message.queuePosition ?? b.message.queueSequence ?? Infinity) ||
    a.message.createdAtUnixMs - b.message.createdAtUnixMs || a.key.localeCompare(b.key)));
  return { timeline: turns.flatMap(turn => turn.rows), queued };
}
