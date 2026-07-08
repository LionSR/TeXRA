/**
 * Shared formatters for rendering a stored execution conversation
 * (`ExecutionKVStore.readConversation()`) as text.
 *
 * A stored conversation is `unknown[]` — whichever model handler produced it
 * (Anthropic, OpenAI, Google, OpenRouter) writes its own provider-native
 * message shape, so `content` blocks show up as Anthropic-style
 * `{type: 'text'|'tool_use'|'tool_result'}`, Google's discriminator-less
 * `{text}`/`{functionCall}`/`{functionResponse}` parts, or OpenAI's top-level
 * `tool_calls`. This module recognizes those shapes once, instead of every
 * caller re-parsing them with its own drifted truncation rules.
 *
 * Used by:
 *  - `ExecutionsTool`'s `/executions/{id}/conversation` endpoint
 *    (`src/tools/executions/conversationFormat.ts`)
 *  - the CLI's `texra history` / resume previews
 *    (`packages/cli/src/runtime/history/conversationFormat.ts`)
 *
 * Callers keep their own message-level composition (XML-ish `<message>`
 * blocks for the tools endpoint; a structured preview/transcript shape plus
 * whole-message truncation for the CLI) — only the per-content-block
 * recognition and truncation below is shared.
 */
import { isObject } from '@utils/core';

const DEFAULT_TRUNCATION_MARKER = '...';

export const HIDDEN_PROVIDER_REASONING_MARKER = '[provider reasoning hidden]';

export interface ConversationFormatOptions {
  /** Truncate string/JSON-ish top-level message content at this many chars. Omit for no limit. */
  readonly textLimit?: number;
  /** Truncate tool_use/tool_result (and Google functionCall/functionResponse) block text at this many chars. Omit for no limit. */
  readonly toolBlockLimit?: number;
  /** Suffix appended to a truncated value. Defaults to `'...'`. */
  readonly truncationMarker?: string;
  /** Render a `[tool_use: ...]` marker for tool-call blocks. Defaults to `true`. */
  readonly includeToolUseMarkers?: boolean;
  /** Include the call's input/args in the tool_use marker (`name(json)` vs bare `name`). Defaults to `true`. */
  readonly includeToolUseInput?: boolean;
  /** Render `thinking`/`redacted_thinking` blocks as `''` instead of their JSON form. Defaults to `false`. */
  readonly hideProviderReasoning?: boolean;
}

export function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function objectStringField(value: unknown, key: string): string {
  return isObject(value) ? asText(value[key]) : '';
}

/** `JSON.stringify` returns `undefined` for undefined/symbol/function values; fall back to `''` so truncation never sees a non-string. */
export function stringifyConversationValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

// Deliberately ASCII-only (`...`, code-unit slicing) rather than
// `truncateWithEllipsis`'s Unicode `…` + grapheme-aware cut — this output
// feeds plain-text conversation views (the ExecutionsTool endpoint, the CLI
// transcript) that must stay pure ASCII.
function truncate(
  str: string,
  maxLen: number | undefined,
  marker: string,
): string {
  if (maxLen === undefined || str.length <= maxLen) return str;
  return `${str.slice(0, Math.max(maxLen - marker.length, 0))}${marker}`;
}

export function hasProviderReasoningBlock(content: unknown): boolean {
  if (Array.isArray(content)) return content.some(isProviderReasoningBlock);
  return isProviderReasoningBlock(content);
}

function isProviderReasoningBlock(block: unknown): boolean {
  return (
    isObject(block) &&
    (block.type === 'thinking' || block.type === 'redacted_thinking')
  );
}

function extractGoogleFunctionResponseContent(
  functionResponse: Record<string, unknown>,
): unknown {
  const response = isObject(functionResponse.response)
    ? functionResponse.response
    : undefined;
  if (response && Object.hasOwn(response, 'result')) return response.result;
  if (response !== undefined) return response;
  return functionResponse;
}

function formatToolUseMarker(
  name: string,
  input: unknown,
  options: ConversationFormatOptions,
): string {
  if (options.includeToolUseMarkers === false) return '';
  if (options.includeToolUseInput === false) return `[tool_use: ${name}]`;
  const marker = options.truncationMarker ?? DEFAULT_TRUNCATION_MARKER;
  const inputJson = truncate(
    stringifyConversationValue(input ?? {}),
    options.toolBlockLimit,
    marker,
  );
  return `[tool_use: ${name}(${inputJson})]`;
}

function formatToolResultMarker(
  content: unknown,
  options: ConversationFormatOptions,
): string {
  const marker = options.truncationMarker ?? DEFAULT_TRUNCATION_MARKER;
  const inner = Array.isArray(content)
    ? content
        .map((block) => formatConversationBlock(block, options))
        .join('\n')
        .trim()
    : typeof content === 'string'
      ? content
      : stringifyConversationValue(content);
  return `[tool_result: ${truncate(inner, options.toolBlockLimit, marker)}]`;
}

/**
 * Render a single content-block (an element of a message's `content`/`parts`
 * array) to text. Handles Anthropic's `{type: ...}` discriminated blocks,
 * Google's discriminator-less `{text}`/`{functionCall}`/`{functionResponse}`
 * parts, and falls back to a JSON dump for unrecognized shapes.
 */
function formatConversationBlock(
  block: unknown,
  options: ConversationFormatOptions = {},
): string {
  const marker = options.truncationMarker ?? DEFAULT_TRUNCATION_MARKER;
  if (typeof block === 'string') return block;
  if (!isObject(block)) {
    return truncate(
      stringifyConversationValue(block),
      options.toolBlockLimit,
      marker,
    );
  }
  // Google's `parts` entries have no `type` discriminator at all — a plain
  // `text` field is the only signal, so check it before the `type` switch.
  if (typeof block.text === 'string') return block.text;

  if (
    isObject(block.inlineData) ||
    isObject(block.fileData) ||
    isObject(block.image_url) ||
    isObject(block.source)
  ) {
    const mimeType =
      asText(block.mimeType) ||
      asText(block.media_type) ||
      objectStringField(block.inlineData, 'mimeType') ||
      objectStringField(block.inlineData, 'mime_type') ||
      objectStringField(block.fileData, 'mimeType') ||
      objectStringField(block.fileData, 'mime_type') ||
      objectStringField(block.image_url, 'mime_type') ||
      objectStringField(block.source, 'media_type');
    return mimeType.startsWith('image/')
      ? '[image attachment]'
      : '[document attachment]';
  }

  if (isObject(block.functionCall)) {
    return formatToolUseMarker(
      asText(block.functionCall.name) || 'unknown',
      block.functionCall.args,
      options,
    );
  }
  if (isObject(block.functionResponse)) {
    return formatToolResultMarker(
      extractGoogleFunctionResponseContent(block.functionResponse),
      options,
    );
  }

  switch (block.type) {
    case 'text':
      // A recognized text block whose `text` failed the duck-type check
      // above (missing/non-string) — render empty, not its JSON form.
      return asText(block.text);
    case 'image':
    case 'image_url':
    case 'input_image':
      return '[image attachment]';
    case 'document':
    case 'file':
    case 'input_file':
      return '[document attachment]';
    case 'thinking':
    case 'redacted_thinking':
      return options.hideProviderReasoning
        ? ''
        : truncate(
            stringifyConversationValue(block),
            options.toolBlockLimit,
            marker,
          );
    case 'tool_use':
      return formatToolUseMarker(
        asText(block.name) || 'unknown',
        block.input,
        options,
      );
    case 'tool_result':
      return formatToolResultMarker(block.content, options);
    default:
      return truncate(
        stringifyConversationValue(block),
        options.toolBlockLimit,
        marker,
      );
  }
}

/**
 * Render a message's `content` (or Google's `parts`) field to text: a string
 * passes through (truncated at `textLimit`), an array joins each block's
 * rendering, and any other JSON-ish value is stringified (also truncated at
 * `textLimit`).
 */
export function formatConversationContent(
  content: unknown,
  options: ConversationFormatOptions = {},
): string {
  const marker = options.truncationMarker ?? DEFAULT_TRUNCATION_MARKER;
  if (content == null) return '';
  if (typeof content === 'string') {
    return truncate(content, options.textLimit, marker);
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => formatConversationBlock(block, options))
      .join('\n')
      .trim();
  }
  return truncate(
    stringifyConversationValue(content),
    options.textLimit,
    marker,
  );
}
