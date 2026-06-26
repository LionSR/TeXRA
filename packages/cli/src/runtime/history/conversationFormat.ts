import { isObject } from '@utils/core/typeGuards';

import type {
  CliHistoryConversationPreview,
  CliHistoryConversationPreviewMessage,
} from '../history';

const CONVERSATION_PREVIEW_MESSAGE_LIMIT = 3;
const CONVERSATION_PREVIEW_CONTENT_LIMIT = 4000;
const HIDDEN_PROVIDER_REASONING_MARKER = '[provider reasoning hidden]';

interface ConversationMessageFormatOptions {
  readonly includeToolUseMarkers?: boolean;
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
  const role = typeof raw.role === 'string' ? raw.role : '';
  const parts = [
    formatConversationMessageContent(raw.content, options),
    formatConversationMessageContent(raw.parts, options),
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

function formatConversationMessageContent(
  content: unknown,
  options: ConversationMessageFormatOptions,
): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => formatConversationContentBlock(block, options))
      .join('\n')
      .trim();
  }
  return formatJsonish(content);
}

function formatConversationContentBlock(
  block: unknown,
  options: ConversationMessageFormatOptions,
): string {
  if (typeof block === 'string') return block;
  if (!isObject(block)) return formatJsonish(block);
  if (typeof block.text === 'string') return block.text;

  if (isObject(block.functionCall)) {
    if (options.includeToolUseMarkers !== true) return '';
    const name =
      typeof block.functionCall.name === 'string'
        ? block.functionCall.name
        : 'unknown';
    return `[tool_use: ${name}]`;
  }

  if (isObject(block.functionResponse)) {
    return `[tool_result: ${formatGoogleFunctionResponse(block.functionResponse, options)}]`;
  }

  switch (block.type) {
    case 'thinking':
    case 'redacted_thinking':
      return '';
    case 'tool_use':
      if (options.includeToolUseMarkers !== true) return '';
      return `[tool_use: ${String(block.name ?? 'unknown')}]`;
    case 'tool_result':
      return `[tool_result: ${formatConversationMessageContent(block.content, options)}]`;
    default:
      return formatJsonish(block);
  }
}

function hasProviderReasoningBlock(content: unknown): boolean {
  if (Array.isArray(content)) return content.some(isProviderReasoningBlock);
  return isProviderReasoningBlock(content);
}

function isProviderReasoningBlock(block: unknown): boolean {
  return (
    isObject(block) &&
    (block.type === 'thinking' || block.type === 'redacted_thinking')
  );
}

function formatGoogleFunctionResponse(
  functionResponse: Record<string, unknown>,
  options: ConversationMessageFormatOptions,
): string {
  const response = isObject(functionResponse.response)
    ? functionResponse.response
    : undefined;
  if (response && Object.hasOwn(response, 'result')) {
    return formatConversationMessageContent(response.result, options);
  }
  if (response !== undefined) {
    return formatConversationMessageContent(response, options);
  }
  return formatJsonish(functionResponse);
}

function formatTopLevelToolCalls(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map(formatTopLevelToolCall);
}

function formatTopLevelToolCall(toolCall: unknown): string {
  if (!isObject(toolCall)) return `[tool_use: ${formatJsonish(toolCall)}]`;
  const nestedFunction = isObject(toolCall.function)
    ? toolCall.function
    : undefined;
  const name =
    typeof nestedFunction?.name === 'string'
      ? nestedFunction.name
      : typeof toolCall.name === 'string'
        ? toolCall.name
        : 'unknown';
  return `[tool_use: ${name}]`;
}

function formatJsonish(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}
