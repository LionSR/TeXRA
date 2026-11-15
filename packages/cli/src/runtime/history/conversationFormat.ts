import {
  formatConversationMessage,
  type ExportNode,
} from '@texra-ai/harness/host';

import type {
  CliHistoryConversation,
  CliHistoryConversationMessage,
} from '../history';

const CONVERSATION_PREVIEW_MESSAGE_LIMIT = 3;
const CONVERSATION_PREVIEW_CONTENT_LIMIT = 4000;

interface ConversationMessageFormatOptions {
  readonly includeToolUseMarkers: boolean;
  readonly contentLimit?: number;
}

export function createConversationPreview(
  conversation: readonly ExportNode[],
): CliHistoryConversation | null {
  const transcript = buildConversationMessages(conversation, {
    includeToolUseMarkers: false,
    contentLimit: CONVERSATION_PREVIEW_CONTENT_LIMIT,
  });
  if (!transcript) return null;

  const lastAssistant = transcript.messages.findLast(
    (message) => message.role === 'assistant',
  );
  const selected = lastAssistant
    ? [lastAssistant]
    : transcript.messages.slice(-CONVERSATION_PREVIEW_MESSAGE_LIMIT);

  return { ...transcript, scope: 'preview', messages: selected };
}

export function createConversationTranscript(
  conversation: readonly ExportNode[],
): CliHistoryConversation | null {
  return buildConversationMessages(conversation, {
    includeToolUseMarkers: true,
  });
}

function buildConversationMessages(
  conversation: readonly ExportNode[],
  options: ConversationMessageFormatOptions,
): CliHistoryConversation | null {
  if (conversation.length === 0) return null;
  const messages = conversation
    .map((message, i) => toConversationPreviewMessage(message, i + 1, options))
    .filter((message) => message.content.trim().length > 0);
  if (!messages.length) return null;
  return { scope: 'transcript', messageCount: conversation.length, messages };
}

function toConversationPreviewMessage(
  message: ExportNode,
  index: number,
  options: ConversationMessageFormatOptions,
): CliHistoryConversationMessage {
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

export function formatConversation(
  conversation: CliHistoryConversation,
): string {
  const { messages, messageCount } = conversation;
  let shown: string;
  if (conversation.scope === 'transcript') {
    shown =
      messages.length === messageCount
        ? 'all messages'
        : `${messages.length} non-empty messages`;
  } else {
    shown =
      messages.length === 1
        ? `${messages[0]?.role ?? 'message'} message ${messages[0]?.index ?? '?'}`
        : `${messages.length} recent messages`;
  }
  const lines = [`Conversation (${messageCount} messages; showing ${shown}):`];
  for (const message of messages) {
    lines.push('', `[${message.role} #${message.index}]`, message.content);
  }
  return lines.join('\n');
}
