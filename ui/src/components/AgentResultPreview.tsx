import type { AgentConversation } from "../lib/agentConversations";
export function AgentResultPreview({ conversation, onPreviewInWts }: { conversation: AgentConversation; onPreviewInWts?: () => void }) {
  if (!conversation.preview) return null;
  let local = false;
  try { local = conversation.source.kind === "ui" && new URL(conversation.preview.url, window.location.href).origin === window.location.origin; } catch { return null; }
  if (local && onPreviewInWts) return <button type="button" onClick={onPreviewInWts}>Preview in WTS</button>;
  return <a href={conversation.preview.url} target="_blank" rel="noreferrer" title="Current live preview. It can include work after this task.">Open live preview</a>;
}
