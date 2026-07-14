/**
 * Message-level formatter for rendering a stored execution conversation as
 * text, built on the shared per-content-block formatter in
 * `@agent/storage/conversationFormat` (the same block recognition and
 * truncation the CLI's `texra history` conversation previews use).
 * Used by ExecutionsTool's /conversation endpoint; kept free of I/O so the
 * tool class stays focused on path routing and storage access.
 */
import {
  formatConversationMessage,
  type ConversationFormatOptions,
} from '@agent/storage/conversationFormat';

const CONVERSATION_FORMAT_OPTIONS: ConversationFormatOptions = {
  textLimit: 500,
  toolBlockLimit: 100,
};

/** Render a stored conversation as numbered <message> blocks. */
export function formatConversation(conversation: readonly unknown[]): string {
  const messages = conversation.map((msg, i) => {
    const { role, content } = formatConversationMessage(
      msg,
      CONVERSATION_FORMAT_OPTIONS,
    );
    return `<message index="${i + 1}" role="${role}">\n${content}\n</message>`;
  });

  return `Conversation (${conversation.length} messages):\n\n${messages.join('\n\n')}`;
}

/** Slice multi-line output to a 1-based inclusive [start, end] range. */
export function applyViewRange(output: string, viewRange?: number[]): string {
  if (!viewRange || viewRange.length < 2) return output;
  const lines = output.split('\n');
  const [start, end] = viewRange;
  return lines
    .slice(Math.max(start - 1, 0), Math.min(end, lines.length))
    .join('\n');
}
