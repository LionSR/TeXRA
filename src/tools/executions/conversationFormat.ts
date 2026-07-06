/**
 * Message-level formatter for rendering a stored execution conversation as
 * text, built on the shared per-content-block formatter in
 * `@agent/storage/conversationFormat` (the same block recognition and
 * truncation the CLI's `texra history` conversation previews use).
 * Used by ExecutionsTool's /conversation endpoint; kept free of I/O so the
 * tool class stays focused on path routing and storage access.
 */
import {
  formatConversationContent,
  type ConversationFormatOptions,
} from '@agent/storage/conversationFormat';

const CONVERSATION_FORMAT_OPTIONS: ConversationFormatOptions = {
  textLimit: 500,
  toolBlockLimit: 100,
};

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

interface ConversationMessage {
  role?: unknown;
  content?: unknown;
}

/** Render a stored conversation as numbered <message> blocks. */
export function formatConversation(conversation: readonly unknown[]): string {
  const messages = conversation.map((msg, i) => {
    const m = (msg ?? {}) as ConversationMessage;
    // Coerce a missing, non-string, or empty role to "unknown": stored roles
    // are untrusted, and an empty label would render a meaningless role="".
    const role = asText(m.role) || 'unknown';
    const content = formatConversationContent(
      m.content,
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
