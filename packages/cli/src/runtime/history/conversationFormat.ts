import {
  formatResultCount,
  type ExportNode,
} from '@texra-ai/worldline/schemas';
import { formatConversationMessage } from '@texra-ai/worldline/host';

import type {
  CliHistoryConversation,
  CliHistoryConversationMessage,
} from '../history';

const CONVERSATION_PREVIEW_MESSAGE_LIMIT = 3;
const CONVERSATION_PREVIEW_CONTENT_LIMIT = 4000;

type ConversationScope = CliHistoryConversation['scope'];

export function createConversationPreview(
  conversation: readonly ExportNode[],
): CliHistoryConversation | null {
  const transcript = buildConversationMessages(conversation, 'preview');
  if (!transcript) return null;

  const lastAssistant = transcript.messages.findLast(
    (message) => message.role === 'assistant',
  );
  const selected = lastAssistant
    ? [lastAssistant]
    : transcript.messages.slice(-CONVERSATION_PREVIEW_MESSAGE_LIMIT);

  return { ...transcript, messages: selected };
}

export function createConversationTranscript(
  conversation: readonly ExportNode[],
): CliHistoryConversation | null {
  return buildConversationMessages(conversation, 'transcript');
}

function buildConversationMessages(
  conversation: readonly ExportNode[],
  scope: ConversationScope,
): CliHistoryConversation | null {
  if (conversation.length === 0) return null;
  const messages = conversation
    .map((message, i) => toConversationPreviewMessage(message, i + 1, scope))
    .filter((message) => message.content.trim().length > 0);
  if (!messages.length) return null;
  return { scope, messageCount: conversation.length, messages };
}

function toConversationPreviewMessage(
  message: ExportNode,
  index: number,
  scope: ConversationScope,
): CliHistoryConversationMessage {
  const { role, content } = formatConversationMessage(message, {
    // The CLI truncates once at the whole-message level below and hides
    // provider reasoning and tool inputs from history output; only the full
    // transcript marks tool calls.
    includeToolUseMarkers: scope === 'transcript',
    includeToolUseInput: false,
    hideProviderReasoning: true,
  });
  // Only the preview caps each message's length.
  const truncated =
    scope === 'preview' && content.length > CONVERSATION_PREVIEW_CONTENT_LIMIT;
  return {
    index,
    role,
    content: truncated
      ? `${content.slice(0, CONVERSATION_PREVIEW_CONTENT_LIMIT).trimEnd()}\n...[truncated]`
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
        : formatResultCount(messages.length, 'non-empty message');
  } else {
    shown =
      messages.length === 1
        ? `${messages[0]?.role ?? 'message'} message ${messages[0]?.index ?? '?'}`
        : `${messages.length} recent messages`;
  }
  const lines = [
    `Conversation (${formatResultCount(messageCount, 'message')}; showing ${shown}):`,
  ];
  for (const message of messages) {
    lines.push('', `[${message.role} #${message.index}]`, message.content);
  }
  return lines.join('\n');
}
