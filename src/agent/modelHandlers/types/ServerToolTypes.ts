/**
 * Unified types for server-side (native) tool results across providers.
 *
 * Server tools are executed by the provider (Anthropic, OpenAI, Google) rather
 * than locally. This module provides a unified abstraction layer.
 *
 * Uses native SDK types where available for better type safety and maintainability.
 * Zod schemas are the single source of truth; types are derived via z.infer<>.
 */

import { z } from 'zod';

// SDK type imports - using native types for better type safety
// Consumers should import SDK types directly from the respective SDKs:
// - Anthropic: '@anthropic-ai/sdk/resources/messages'
// - OpenAI: 'openai/resources/responses/responses'
import type {
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  WebSearchResultBlock,
} from '@anthropic-ai/sdk/resources/messages';
import type {
  ResponseFunctionWebSearch,
  ResponseReasoningItem,
} from 'openai/resources/responses/responses';

// ============================================================================
// Web Search Result Schemas - Single Source of Truth
// ============================================================================

/**
 * Schema for a single web search result entry.
 * Normalized across all providers.
 */
export const WebSearchResultEntrySchema = z.object({
  /** URL of the search result */
  url: z.string(),
  /** Title of the page */
  title: z.string(),
  /** Text snippet/description (may be encrypted for Anthropic) */
  snippet: z.string().optional(),
  /** Domain extracted from URL */
  domain: z.string().optional(),
  /** Page age/freshness hint (Anthropic only) */
  pageAge: z.string().optional(),
});

/** A single web search result entry - derived from schema. */
export type WebSearchResultEntry = z.infer<typeof WebSearchResultEntrySchema>;

/**
 * Schema for unified web search result across all providers.
 */
export const WebSearchResultSchema = z.object({
  /** The search query that was executed */
  query: z.string(),
  /** Search result entries */
  results: z.array(WebSearchResultEntrySchema),
  /** Provider that executed the search */
  provider: z.enum(['anthropic', 'openai']),
  /** Unique identifier for this search call */
  callId: z.string().optional(),
  /** Status of the search */
  status: z.enum(['completed', 'in_progress', 'failed']),
});

/** Unified web search result - derived from schema. */
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;

// ============================================================================
// Server Tool Content Block Types
// ============================================================================

/**
 * Union of all raw content block types that can be returned by server tools.
 * These blocks need to be preserved in conversation context for follow-up messages.
 *
 * - Anthropic: ServerToolUseBlock (the call) and WebSearchToolResultBlock (the result)
 * - OpenAI: ResponseFunctionWebSearch (combined call/result) and ResponseReasoningItem
 *   (reasoning items must be included when web_search_call references them)
 */
export type ServerToolContentBlock =
  | ServerToolUseBlock
  | WebSearchToolResultBlock
  | ResponseFunctionWebSearch
  | ResponseReasoningItem;

/**
 * Combined result from server tool extraction.
 * Single source of truth for both display (webSearchResults) and context (contentBlocks).
 */
export interface ServerToolExtractionResult {
  /** Normalized web search results for display in progress view */
  webSearchResults: WebSearchResult[];
  /** Raw content blocks to preserve in conversation context */
  contentBlocks: ServerToolContentBlock[];
}

// ============================================================================
// Type Guards - Using SDK types for better type safety
// ============================================================================

/**
 * Type guard for Anthropic server tool use block.
 * Uses SDK's ServerToolUseBlock type for proper typing.
 */
export function isAnthropicServerToolUse(
  block: unknown,
): block is ServerToolUseBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: string }).type === 'server_tool_use'
  );
}

/**
 * Type guard for Anthropic web search result block.
 * Uses SDK's WebSearchToolResultBlock type for proper typing.
 */
export function isAnthropicWebSearchResult(
  block: unknown,
): block is WebSearchToolResultBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: string }).type === 'web_search_tool_result'
  );
}

/**
 * Type guard for OpenAI web search call.
 * Uses SDK's ResponseFunctionWebSearch type for proper typing.
 */
export function isOpenAIWebSearchCall(
  item: unknown,
): item is ResponseFunctionWebSearch {
  return (
    typeof item === 'object' &&
    item !== null &&
    (item as { type?: string }).type === 'web_search_call'
  );
}

/**
 * Type guard for OpenAI reasoning item.
 * Uses SDK's ResponseReasoningItem type for proper typing.
 * Reasoning items must be preserved when web_search_call references them.
 */
export function isOpenAIReasoningItem(
  item: unknown,
): item is ResponseReasoningItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    (item as { type?: string }).type === 'reasoning'
  );
}

/**
 * Type guard for OpenAI server tool content blocks.
 * Checks if an item is either a web search call or reasoning item.
 * Used to identify content that needs to be preserved in conversation context.
 * Reasoning items must be included when web_search_call references them.
 */
export function isOpenAIServerToolContent(
  item: unknown,
): item is ResponseFunctionWebSearch | ResponseReasoningItem {
  return isOpenAIWebSearchCall(item) || isOpenAIReasoningItem(item);
}

/**
 * Type guard for Anthropic server tool content blocks.
 * Checks if a block is either a server tool use or web search result.
 * Used to identify content that needs to be preserved in conversation context.
 */
export function isAnthropicServerToolContent(
  block: unknown,
): block is ServerToolUseBlock | WebSearchToolResultBlock {
  return isAnthropicServerToolUse(block) || isAnthropicWebSearchResult(block);
}

// ============================================================================
// Result Extraction Helpers - Using SDK types for type safety
// ============================================================================

/**
 * Type guard for WebSearchResultBlock array content.
 * The SDK's WebSearchToolResultBlockContent is a union of error or results array.
 */
function isWebSearchResultArray(
  content: WebSearchToolResultBlock['content'],
): content is WebSearchResultBlock[] {
  return Array.isArray(content);
}

/**
 * Extract web search results from Anthropic response content.
 * Uses SDK's WebSearchToolResultBlock and WebSearchResultBlock types.
 * Correlates server_tool_use blocks (which contain the query) with
 * web_search_tool_result blocks (which contain the results).
 */
export function extractAnthropicWebSearchResults(
  content: unknown[],
): WebSearchResult[] {
  const results: WebSearchResult[] = [];

  // First pass: build a map of tool_use_id -> query from server_tool_use blocks
  const queryMap = new Map<string, string>();
  for (const block of content) {
    if (isAnthropicServerToolUse(block) && block.name === 'web_search') {
      const input = block.input as { query?: string } | undefined;
      if (input?.query) {
        queryMap.set(block.id, input.query);
      }
    }
  }

  // Second pass: extract results and match with queries
  for (const block of content) {
    if (!isAnthropicWebSearchResult(block)) {
      continue;
    }

    // block is now properly typed as WebSearchToolResultBlock
    if (!isWebSearchResultArray(block.content)) {
      // Content is an error, not results
      continue;
    }

    // block.content is now properly typed as WebSearchResultBlock[]
    const entries: WebSearchResultEntry[] = block.content
      .filter(
        (r): r is WebSearchResultBlock =>
          r.type === 'web_search_result' && !!r.url,
      )
      .map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.encrypted_content,
        pageAge: r.page_age ?? undefined,
        domain: extractDomain(r.url),
      }));

    if (entries.length > 0) {
      // Look up the query from the corresponding server_tool_use block
      const query = queryMap.get(block.tool_use_id) ?? '';
      results.push({
        query,
        results: entries,
        provider: 'anthropic',
        callId: block.tool_use_id,
        status: 'completed',
      });
    }
  }

  return results;
}

/**
 * Extended web search interface with optional action field.
 * The action field is only populated when using include: ['web_search_call.action.sources'].
 * Uses SDK's ResponseFunctionWebSearch.Search type for the action structure.
 */
type ResponseFunctionWebSearchWithAction = Omit<
  ResponseFunctionWebSearch,
  'action'
> & {
  action?: ResponseFunctionWebSearch.Search;
};

/**
 * Build a WebSearchResult from a single OpenAI web search item.
 * Shared helper used by both streaming emission and final response extraction.
 *
 * Handles both cases:
 * - Default API response: only id, status, type (no action/sources)
 * - With include sources: action field contains query and sources
 */
export function buildOpenAIWebSearchResult(
  item: ResponseFunctionWebSearch,
): WebSearchResult {
  const searchItem = item as ResponseFunctionWebSearchWithAction;

  // Determine status using SDK's status type
  const status: WebSearchResult['status'] =
    searchItem.status === 'completed'
      ? 'completed'
      : searchItem.status === 'failed'
        ? 'failed'
        : 'in_progress';

  const action = searchItem.action;

  // Handle case when action is not present (default API response)
  if (!action) {
    return {
      query: '',
      results: [],
      provider: 'openai',
      callId: searchItem.id,
      status,
    };
  }

  // Handle case when action is present (include sources was used)
  const entries: WebSearchResultEntry[] = (action.sources ?? []).map((s) => ({
    url: s.url,
    title: '', // OpenAI sources don't include titles in basic response
    domain: extractDomain(s.url),
  }));

  return {
    query: action.query ?? '',
    results: entries,
    provider: 'openai',
    callId: searchItem.id,
    status,
  };
}

/**
 * Check if a web search item has meaningful data (action field with query).
 * During streaming, web search items may be emitted without the action field,
 * which results in empty searches being displayed. Use this to filter them out.
 */
export function hasOpenAIWebSearchData(
  item: ResponseFunctionWebSearch,
): boolean {
  const searchItem = item as ResponseFunctionWebSearchWithAction;
  return Boolean(searchItem.action?.query);
}

/**
 * Extract web search results from OpenAI Responses API output.
 * Uses SDK's ResponseFunctionWebSearch type for proper typing.
 *
 * Note: The OpenAI Responses API returns web_search_call items with only
 * basic fields (id, status, type) by default. The action field with sources
 * is only populated when using include: ['web_search_call.action.sources'].
 * This extractor handles both cases gracefully.
 */
export function extractOpenAIWebSearchResults(
  output: unknown[],
): WebSearchResult[] {
  const results: WebSearchResult[] = [];

  for (const item of output) {
    if (!isOpenAIWebSearchCall(item)) {
      continue;
    }

    results.push(buildOpenAIWebSearchResult(item));
  }

  return results;
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Extract domain from URL.
 */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch (_err) {
    return '';
  }
}
