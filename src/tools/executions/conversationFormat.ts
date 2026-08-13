/**
 * Message-level formatter for rendering a stored execution conversation as
 * text, built on the shared per-content-block formatter in
 * `@agent/storage/conversationFormat` (the same block recognition and
 * truncation the CLI's `texra history` conversation previews use).
 * Pure: the caller owns storage access and paging.
 */
import {
  formatConversationMessage,
  type ConversationFormatOptions,
} from '@agent/storage/conversationFormat';
const CONVERSATION_FORMAT_OPTIONS: ConversationFormatOptions = {
  textLimit: 500,
  toolBlockLimit: 100,
};

export interface ConversationPageFormatOptions {
  /** Zero-based index of the first message in this page. */
  readonly offset?: number;
  /** Total messages in the unsliced archive. */
  readonly totalMessages?: number;
  /** Archive-selection facts shown before the message blocks. */
  readonly metadata?: readonly string[];
}

/** Render a stored conversation as numbered <message> blocks. */
export function formatConversation(
  conversation: readonly unknown[],
  options: ConversationPageFormatOptions = {},
): string {
  const offset = options.offset ?? 0;
  const totalMessages = options.totalMessages ?? conversation.length;
  const messages = conversation.map((msg, i) => {
    const { role, content } = formatConversationMessage(
      msg,
      CONVERSATION_FORMAT_OPTIONS,
    );
    return `<message index="${offset + i + 1}" role="${role}">\n${content}\n</message>`;
  });

  return [
    `Conversation (${totalMessages} messages):`,
    ...(options.metadata ?? []),
    '',
    messages.join('\n\n'),
  ].join('\n');
}
