import { formatConversationMessage } from '@agent/storage/conversationFormat';

import type {
  CliHistoryConversationPreview,
  CliHistoryConversationPreviewMessage,
} from '../history';

const CONVERSATION_PREVIEW_MESSAGE_LIMIT = 3;
const CONVERSATION_PREVIEW_CONTENT_LIMIT = 4000;

interface ConversationMessageFormatOptions {
  readonly includeToolUseMarkers: boolean;
  readonly contentLimit?: number;
}

export function createConversationPreview(
  conversation: readonly unknown[] | null,
): CliHistoryConversationPreview | null {
  const transcript = buildConversationMessages(conversation, {
    includeToolUseMarkers: false,
    contentLimit: CONVERSATION_PREVIEW_CONTENT_LIMIT,
  });
  if (!transcript) return null;

  const lastAssistant = transcript.messages.findLast(
    (message) => message.role === 'assistant' || message.role === 'model',
  );
  const selected = lastAssistant
    ? [lastAssistant]
    : transcript.messages.slice(-CONVERSATION_PREVIEW_MESSAGE_LIMIT);

  return {
    messageCount: transcript.messageCount,
    messages: selected,
  };
}

export function createConversationTranscript(
  conversation: readonly unknown[] | null,
): CliHistoryConversationPreview | null {
  return buildConversationMessages(conversation, {
    includeToolUseMarkers: true,
  });
}

function buildConversationMessages(
  conversation: readonly unknown[] | null,
  options: ConversationMessageFormatOptions,
): CliHistoryConversationPreview | null {
  if (!conversation?.length) return null;
  const messages = conversation
    .map((message, i) => toConversationPreviewMessage(message, i + 1, options))
    .filter((message) => message.content.trim().length > 0);
  if (!messages.length) return null;
  return {
    messageCount: conversation.length,
    messages,
  };
}

function toConversationPreviewMessage(
  message: unknown,
  index: number,
  options: ConversationMessageFormatOptions,
): CliHistoryConversationPreviewMessage {
  const { role, content } = formatConversationMessage(message, {
    // The CLI truncates once at the whole-message level below and hides
    // provider reasoning and tool inputs from history output.
    includeToolUseMarkers: options.includeToolUseMarkers,
    includeToolUseInput: false,
    hideProviderReasoning: true,
  });
  const truncated =
    options.contentLimit !== undefined && content.length > options.contentLimit;
  return {
    index,
    role,
    content: truncated
      ? `${content.slice(0, options.contentLimit).trimEnd()}\n...[truncated]`
      : content,
    truncated,
  };
}

export function formatConversationPreview(
  preview: CliHistoryConversationPreview,
): string {
  const shown =
    preview.messages.length === 1
      ? `${preview.messages[0]?.role ?? 'message'} message ${preview.messages[0]?.index ?? '?'}`
      : `${preview.messages.length} recent messages`;
  return formatConversationMessages(preview, shown);
}

export function formatConversationTranscript(
  transcript: CliHistoryConversationPreview,
): string {
  const shown =
    transcript.messages.length === transcript.messageCount
      ? 'all messages'
      : `${transcript.messages.length} non-empty messages`;
  return formatConversationMessages(transcript, shown);
}

function formatConversationMessages(
  transcript: CliHistoryConversationPreview,
  shown: string,
): string {
  const lines = [
    `Conversation (${transcript.messageCount} messages; showing ${shown}):`,
  ];
  for (const message of transcript.messages) {
    lines.push('', `[${message.role} #${message.index}]`, message.content);
  }
  return lines.join('\n');
}
