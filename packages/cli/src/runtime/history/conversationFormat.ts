import {
  formatConversationContent,
  hasProviderReasoningBlock,
  stringifyConversationValue,
  HIDDEN_PROVIDER_REASONING_MARKER,
  type ConversationFormatOptions,
} from '@agent/storage/conversationFormat';
import { isObject } from '@utils/core/typeGuards';

import type {
  CliHistoryConversationPreview,
  CliHistoryConversationPreviewMessage,
} from '../history';

const CONVERSATION_PREVIEW_MESSAGE_LIMIT = 3;
const CONVERSATION_PREVIEW_CONTENT_LIMIT = 4000;

interface ConversationMessageFormatOptions {
  readonly includeToolUseMarkers?: boolean;
  readonly contentLimit?: number;
}

/**
 * The shared formatter never truncates tool_use/tool_result blocks or shows
 * their input/args for the CLI (unlike the ExecutionsTool endpoint, which
 * truncates both) — the CLI truncates once, at the whole-message level, in
 * {@link toConversationPreviewMessage}. Provider-reasoning (`thinking`)
 * blocks are always hidden here (surfaced instead via
 * {@link HIDDEN_PROVIDER_REASONING_MARKER} when they're the only content).
 */
function toBlockFormatOptions(
  options: ConversationMessageFormatOptions,
): ConversationFormatOptions {
  return {
    includeToolUseMarkers: options.includeToolUseMarkers,
    includeToolUseInput: false,
    hideProviderReasoning: true,
  };
}

export function createConversationPreview(
  conversation: readonly unknown[] | null,
): CliHistoryConversationPreview | null {
  const transcript = buildConversationMessages(conversation, {
    includeToolUseMarkers: false,
    contentLimit: CONVERSATION_PREVIEW_CONTENT_LIMIT,
  });
  if (!transcript) return null;

  const lastAssistant = transcript.messages.findLast((message) =>
    isAssistantMessageRole(message.role),
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
  const raw = isObject(message) ? message : {};
  const role = typeof raw.role === 'string' ? raw.role : 'unknown';
  const content = formatConversationMessage(raw, options);
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

function formatConversationMessage(
  raw: Record<string, unknown>,
  options: ConversationMessageFormatOptions,
): string {
  const blockOptions = toBlockFormatOptions(options);
  const role = typeof raw.role === 'string' ? raw.role : '';
  const parts = [
    formatConversationContent(raw.content, blockOptions),
    formatConversationContent(raw.parts, blockOptions),
    ...(options.includeToolUseMarkers === true
      ? formatTopLevelToolCalls(raw.tool_calls)
      : []),
  ].filter((part) => part.trim().length > 0);
  if (parts.length > 0) return parts.join('\n').trim();
  if (
    isAssistantMessageRole(role) &&
    (hasProviderReasoningBlock(raw.content) ||
      hasProviderReasoningBlock(raw.parts))
  ) {
    return HIDDEN_PROVIDER_REASONING_MARKER;
  }
  return '';
}

function isAssistantMessageRole(role: string): boolean {
  return role === 'assistant' || role === 'model';
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

function formatTopLevelToolCalls(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map(formatTopLevelToolCall);
}

function formatTopLevelToolCall(toolCall: unknown): string {
  if (!isObject(toolCall))
    return `[tool_use: ${stringifyConversationValue(toolCall)}]`;
  const nestedFunction = isObject(toolCall.function)
    ? toolCall.function
    : undefined;
  const name =
    [nestedFunction?.name, toolCall.name].find(
      (value): value is string => typeof value === 'string',
    ) ?? 'unknown';
  return `[tool_use: ${name}]`;
}
