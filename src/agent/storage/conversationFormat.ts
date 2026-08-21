/**
 * Shared formatters for rendering a stored execution conversation
 * from archived stream data as text.
 *
 * A stored conversation is `unknown[]` — whichever model handler produced it
 * (Anthropic, OpenAI, Google, OpenRouter, VS Code LM) writes its own
 * provider-native message shape, so `content` blocks show up as Anthropic-style
 * `{type: 'text'|'tool_use'|'tool_result'}`, Google's discriminator-less
 * `{text}`/`{functionCall}`/`{functionResponse}` parts, VS Code LM's
 * `{kind: 'text'|'toolCall'|'toolResult'}` parts, or OpenAI's top-level
 * `tool_calls`. This module recognizes those shapes once, instead of every
 * caller re-parsing them with its own drifted truncation rules.
 *
 * Used by:
 *  - `ExecutionsTool`'s `/executions/{id}/conversation` endpoint
 *    (`src/tools/executions/conversationFormat.ts`)
 *  - the CLI's `texra history` / resume previews
 *    (`packages/cli/src/runtime/history/conversationFormat.ts`)
 *
 * Callers keep their own output composition (XML-ish `<message>` blocks for
 * the tools endpoint; a structured preview/transcript shape plus whole-message
 * truncation for the CLI). Provider-native message and content recognition is
 * shared here.
 */
import {
  classifyProviderMessageBlockType,
  CONVERSATION_BLOCK_TYPES,
  type ProviderMessageBlockCategory,
} from '@agent/types/ConversationBlockTypes';
import { extractWebFetchResultFields } from '@agent/types/ServerTools';
import { assertNever, isObject } from '@utils/core';
import { isImageMimeType } from '@utils/files/mimeUtils';

const HIDDEN_PROVIDER_REASONING_MARKER = '[provider reasoning hidden]';

export interface ConversationFormatOptions {
  /** Truncate each string/text message value at this many chars. Omit for no limit. */
  readonly textLimit?: number;
  /** Truncate tool_use/tool_result (and Google functionCall/functionResponse) block text at this many chars. Omit for no limit. */
  readonly toolBlockLimit?: number;
  /** Render a `[tool_use: ...]` marker for tool-call blocks. Defaults to `true`. */
  readonly includeToolUseMarkers?: boolean;
  /** Include the call's input/args in the tool_use marker (`name(json)` vs bare `name`). Defaults to `true`. */
  readonly includeToolUseInput?: boolean;
  /** Render `thinking`/`redacted_thinking` blocks as `''` instead of their JSON form. Defaults to `false`. */
  readonly hideProviderReasoning?: boolean;
}

function asText(value: unknown): string {
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
function truncate(str: string, maxLen: number | undefined): string {
  if (maxLen === undefined || str.length <= maxLen) return str;
  return `${str.slice(0, Math.max(maxLen - 3, 0))}...`;
}

function hasProviderReasoningBlock(content: unknown): boolean {
  if (Array.isArray(content)) return content.some(isProviderReasoningBlock);
  return isProviderReasoningBlock(content);
}

function isProviderReasoningBlock(block: unknown): boolean {
  return (
    isObject(block) &&
    (block.type === CONVERSATION_BLOCK_TYPES.thinking ||
      block.type === CONVERSATION_BLOCK_TYPES.redactedThinking)
  );
}

function extractGoogleFunctionResponseContent(
  functionResponse: Record<string, unknown>,
): unknown {
  const response = isObject(functionResponse.response)
    ? functionResponse.response
    : undefined;
  if (response && Object.hasOwn(response, 'result')) return response.result;
  return response ?? functionResponse;
}

function formatToolUseMarker(
  name: string,
  input: unknown,
  options: ConversationFormatOptions,
): string {
  if (options.includeToolUseMarkers === false) return '';
  if (options.includeToolUseInput === false) return `[tool_use: ${name}]`;
  const inputJson = truncate(
    typeof input === 'string' ? input : stringifyConversationValue(input ?? {}),
    options.toolBlockLimit,
  );
  return `[tool_use: ${name}(${inputJson})]`;
}

function formatToolResultMarker(
  content: unknown,
  options: ConversationFormatOptions,
): string {
  let inner: string;
  if (Array.isArray(content)) {
    inner = content
      .map((block) => formatConversationBlock(block, options))
      .join('\n')
      .trim();
  } else if (typeof content === 'string') {
    inner = content;
  } else {
    inner = stringifyConversationValue(content);
  }
  return `[tool_result: ${truncate(inner, options.toolBlockLimit)}]`;
}

/**
 * Anthropic `web_search_tool_result` content is an array of
 * `{type: 'web_search_result', title, url, ...}` entries (or an error
 * object) — rendering each entry through the generic block formatter would
 * JSON-dump its `encrypted_content` field, so this collapses the array to a
 * compact `title (url)` list instead. Falls back to `formatToolResultMarker`
 * for the error shape.
 */
function formatWebSearchResultMarker(
  content: unknown,
  options: ConversationFormatOptions,
): string {
  if (!Array.isArray(content)) return formatToolResultMarker(content, options);
  const entries = content
    .filter(isObject)
    .map((entry) => {
      const url = asText(entry.url);
      const title = asText(entry.title) || url;
      return url ? `${title} (${url})` : title;
    })
    .filter(Boolean);
  return `[tool_result: ${truncate(entries.join(', '), options.toolBlockLimit)}]`;
}

/**
 * A live Anthropic `web_fetch_tool_result` block's `content` is a
 * `{type: 'web_fetch_result', url, content: {title, ...}}` object (or an
 * error object). A completed-run's transcript-sidecar archive
 * (`webFetchEntryToMessages` in `@transcript/completedRunArchive`)
 * reconstructs the same block type with no nested `content` at all —
 * `url`/`title`/`page_content` sit directly on the block instead. Both
 * `ExecutionsTool`'s `/conversation` endpoint and the CLI's `texra history`
 * read completed-run conversations through that archive, so this must
 * recognize both shapes; rendering either through the generic block
 * formatter would JSON-dump the fetched page's full text, so this collapses
 * whichever shape is present to a `title (url)` marker instead. Falls back
 * to `formatToolResultMarker` for the live error shape.
 */
function formatWebFetchResultMarker(
  block: Record<string, unknown>,
  options: ConversationFormatOptions,
): string {
  const result = extractWebFetchResultFields(block);
  if (result) {
    const { title = '', url = '' } = result;
    const label =
      title && url ? `${title} (${url})` : title || url || 'web_fetch_result';
    return `[tool_result: ${truncate(label, options.toolBlockLimit)}]`;
  }
  return formatToolResultMarker(block.content, options);
}

/**
 * Render a single content-block (an element of a message's `content`/`parts`
 * array) to text. Handles Anthropic's `{type: ...}` discriminated blocks,
 * Google's discriminator-less `{text}`/`{functionCall}`/`{functionResponse}`
 * parts, VS Code LM's `kind`-discriminated parts, and falls back to a JSON dump
 * for unrecognized shapes.
 */
function formatConversationBlock(
  block: unknown,
  options: ConversationFormatOptions = {},
): string {
  if (typeof block === 'string') {
    return truncate(block, options.textLimit);
  }
  if (!isObject(block)) {
    return truncate(stringifyConversationValue(block), options.toolBlockLimit);
  }
  switch (block.kind) {
    case 'text':
      return truncate(asText(block.text), options.textLimit);
    case 'toolCall':
      return formatToolUseMarker(
        asText(block.name) || 'unknown',
        block.input,
        options,
      );
    case 'toolResult':
      return formatToolResultMarker(block.text, options);
  }
  // Google's `parts` entries have no `type` discriminator at all — a plain
  // `text` field is the only signal, so check it before the `type` switch.
  if (typeof block.text === 'string') {
    return truncate(block.text, options.textLimit);
  }

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
    return isImageMimeType(mimeType)
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

  // A recognized text block whose `text` failed the duck-type check above
  // (missing/non-string) — render empty, not its JSON form. Only the literal
  // `text` tag gets this treatment: `input_text`/`output_text` are not
  // classified (see `@agent/types/ConversationBlockTypes`) and fall through
  // to the JSON dump below.
  if (block.type === 'text') {
    return truncate(asText(block.text), options.textLimit);
  }

  // Non-text tag classification is shared with `assistantBlockToNode` in
  // `@agent/export/normalizeConversation` via `classifyProviderMessageBlockType`
  // (`@agent/types/ConversationBlockTypes`) — one switch recognizes the tags;
  // each module maps the category into its own output shape (a truncated
  // marker string here vs. a structured `ExportNode` there). The switch is
  // exhaustive over `ProviderMessageBlockCategory` (`default: assertNever`),
  // so a category added to the classifier fails here at compile time instead
  // of silently falling into the JSON dump.
  const category: ProviderMessageBlockCategory | undefined =
    classifyProviderMessageBlockType(block.type);
  switch (category) {
    case 'image-attachment':
      return '[image attachment]';
    case 'document-attachment':
      return '[document attachment]';
    case 'thinking':
      return options.hideProviderReasoning
        ? ''
        : truncate(stringifyConversationValue(block), options.toolBlockLimit);
    // `server-tool-use` is Anthropic's server-side variant (the provider
    // executes it, not a local tool handler) but renders identically here.
    case 'tool-use':
    case 'server-tool-use':
      return formatToolUseMarker(
        asText(block.name) || 'unknown',
        block.input,
        options,
      );
    case 'tool-result':
      return formatToolResultMarker(block.content, options);
    case 'web-search-tool-result':
      return formatWebSearchResultMarker(block.content, options);
    case 'web-fetch-tool-result':
      return formatWebFetchResultMarker(block, options);
    // Unrecognized tags — including the deliberately unclassified
    // `input_text`/`output_text` literals (see the classifier's docstring) —
    // keep the JSON-dump fallback.
    case undefined:
      return truncate(
        stringifyConversationValue(block),
        options.toolBlockLimit,
      );
    default:
      return assertNever(category, 'Unhandled provider message block category');
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
  if (content == null) return '';
  if (typeof content === 'string') {
    return truncate(content, options.textLimit);
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => formatConversationBlock(block, options))
      .join('\n')
      .trim();
  }
  return truncate(stringifyConversationValue(content), options.textLimit);
}

/**
 * Normalize one provider-native stored message to the role and text consumed
 * by conversation views.
 */
export function formatConversationMessage(
  message: unknown,
  options: ConversationFormatOptions = {},
): { role: string; content: string } {
  const raw = isObject(message) ? message : {};
  const role = asText(raw.role) || 'unknown';
  const content = [
    formatConversationContent(raw.content, options),
    formatConversationContent(raw.parts, options),
    formatTopLevelToolCalls(raw.tool_calls, options),
  ]
    .filter((part) => part.trim().length > 0)
    .join('\n')
    .trim();

  if (content) return { role, content };
  const onlyHiddenReasoning =
    options.hideProviderReasoning === true &&
    (role === 'assistant' || role === 'model') &&
    (hasProviderReasoningBlock(raw.content) ||
      hasProviderReasoningBlock(raw.parts));
  return {
    role,
    content: onlyHiddenReasoning ? HIDDEN_PROVIDER_REASONING_MARKER : '',
  };
}

function formatTopLevelToolCalls(
  toolCalls: unknown,
  options: ConversationFormatOptions,
): string {
  if (!Array.isArray(toolCalls) || options.includeToolUseMarkers === false) {
    return '';
  }
  return toolCalls
    .map((toolCall) => formatTopLevelToolCall(toolCall, options))
    .join('\n');
}

function formatTopLevelToolCall(
  toolCall: unknown,
  options: ConversationFormatOptions,
): string {
  if (!isObject(toolCall)) {
    return `[tool_use: ${truncate(
      stringifyConversationValue(toolCall),
      options.toolBlockLimit,
    )}]`;
  }
  const nestedFunction = isObject(toolCall.function)
    ? toolCall.function
    : undefined;
  const name =
    asText(nestedFunction?.name) || asText(toolCall.name) || 'unknown';
  const input =
    nestedFunction?.arguments ?? toolCall.arguments ?? toolCall.input ?? {};
  return formatToolUseMarker(name, input, options);
}
