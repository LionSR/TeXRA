/**
 * Plain-text rendering of a completed run's conversation nodes
 * (`readCompletedRunConversation` in `@transcript/completedRunArchive`).
 *
 * Used by:
 *  - `ExecutionsTool`'s `/executions/{id}/conversation` endpoint
 *    (`src/tools/executions/conversationFormat.ts`)
 *  - the CLI's `texra history` / resume previews
 *    (`packages/cli/src/runtime/history/conversationFormat.ts`)
 *
 * Callers keep their own output composition (XML-ish `<message>` blocks for
 * the tools endpoint; a structured preview/transcript shape plus whole-message
 * truncation for the CLI). Node rendering and truncation are shared here.
 */
import type { ExportNode } from '@agent/export/schemas';
import { assertNever } from '@utils/core';

const HIDDEN_PROVIDER_REASONING_MARKER = '[provider reasoning hidden]';

export interface ConversationFormatOptions {
  /** Truncate user/assistant text at this many chars. Omit for no limit. */
  readonly textLimit?: number;
  /** Truncate tool-call, tool-result, and thinking text at this many chars. Omit for no limit. */
  readonly toolBlockLimit?: number;
  /** Render a `[tool_use: ...]` marker for tool calls. Defaults to `true`. */
  readonly includeToolUseMarkers?: boolean;
  /** Include the call's input/args in the tool_use marker (`name(json)` vs bare `name`). Defaults to `true`. */
  readonly includeToolUseInput?: boolean;
  /** Replace thinking text with a fixed marker. Defaults to `false`. */
  readonly hideProviderReasoning?: boolean;
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

function toolUseMarker(
  name: string,
  input: unknown,
  options: ConversationFormatOptions,
): string {
  if (options.includeToolUseMarkers === false) return '';
  if (options.includeToolUseInput === false) return `[tool_use: ${name}]`;
  const inputJson = truncate(
    typeof input === 'string' ? input : stringifyConversationValue(input),
    options.toolBlockLimit,
  );
  return `[tool_use: ${name}(${inputJson})]`;
}

function toolResultMarker(
  text: string,
  options: ConversationFormatOptions,
): string {
  return `[tool_result: ${truncate(text, options.toolBlockLimit)}]`;
}

function formatNodeContent(
  node: ExportNode,
  options: ConversationFormatOptions,
): string {
  switch (node.kind) {
    case 'user-message':
      return node.parts
        .map((part) =>
          part.type === 'text'
            ? truncate(part.text, options.textLimit)
            : `[${part.attachmentType} attachment]`,
        )
        .join('\n');
    case 'assistant-text':
      return truncate(node.text, options.textLimit);
    case 'thinking':
      return options.hideProviderReasoning
        ? HIDDEN_PROVIDER_REASONING_MARKER
        : `[thinking: ${truncate(node.text, options.toolBlockLimit)}]`;
    case 'tool-call':
      return toolUseMarker(node.name, node.input, options);
    case 'tool-result':
      return toolResultMarker(node.text, options);
    case 'web-search':
      return toolUseMarker('web_search', { query: node.query }, options);
    case 'web-search-results':
      return toolResultMarker(
        node.results.map(({ title, url }) => `${title} (${url})`).join(', '),
        options,
      );
    case 'web-fetch': {
      // A title/url marker, never the fetched page text.
      const { title, url } = node;
      return toolResultMarker(
        title && url ? `${title} (${url})` : title || url || 'web_fetch_result',
        options,
      );
    }
    default:
      return assertNever(node, 'Unhandled export node kind');
  }
}

/** Tool results answer the assistant's call, so they keep the user role. */
const NODE_ROLE = {
  'user-message': 'user',
  'assistant-text': 'assistant',
  thinking: 'assistant',
  'tool-call': 'assistant',
  'tool-result': 'user',
  'web-search': 'assistant',
  'web-search-results': 'assistant',
  'web-fetch': 'assistant',
} as const satisfies Record<ExportNode['kind'], 'user' | 'assistant'>;

/** Render one conversation node as the role and text conversation views show. */
export function formatConversationMessage(
  node: ExportNode,
  options: ConversationFormatOptions = {},
): { role: 'user' | 'assistant'; content: string } {
  return {
    role: NODE_ROLE[node.kind],
    content: formatNodeContent(node, options).trim(),
  };
}
