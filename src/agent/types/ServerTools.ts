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

import * as logger from '@logger/logUtils';
import { isObject, tryParseUrl } from '@utils/core';

// SDK type imports - using native types for better type safety
// Consumers should import SDK types directly from the respective SDKs:
// - Anthropic: '@anthropic-ai/sdk/resources/messages'
// - OpenAI: 'openai/resources/responses/responses'
import type {
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  WebSearchResultBlock,
  WebFetchToolResultBlock,
  WebFetchBlock,
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
const WebSearchResultEntrySchema = z.object({
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
const WebSearchResultSchema = z.object({
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
// Web Fetch Result Schemas - Single Source of Truth
// ============================================================================

/**
 * Schema for unified web fetch result.
 * Represents a single URL fetch performed by the Anthropic server-side tool.
 */
const WebFetchResultSchema = z.object({
  /** The URL that was fetched */
  url: z.string(),
  /** Title of the fetched document (if available) */
  title: z.string().optional(),
  /** Provider that executed the fetch */
  provider: z.literal('anthropic'),
  /** Unique identifier for this fetch call */
  callId: z.string(),
  /** Status of the fetch */
  status: z.enum(['completed', 'failed']),
  /** Error code if fetch failed */
  errorCode: z.string().optional(),
  /** Fetched document text, size-capped via {@link capWebFetchContent} (#7508). */
  content: z.string().optional(),
});

/** Unified web fetch result - derived from schema. */
export type WebFetchResult = z.infer<typeof WebFetchResultSchema>;

// ============================================================================
// Server Tool Content Block Types
// ============================================================================

/**
 * The three live Anthropic server-tool block `type` tags emitted by
 * `AnthropicStreamHandler`. Single source of truth for the block-type
 * vocabulary shared by `formatConversationBlock`
 * (`@agent/storage/conversationFormat`) and `assistantBlockToNode`
 * (`@agent/export/normalizeConversation`), which classify the same three
 * block types into different output shapes (a truncated marker string vs. a
 * structured `ExportNode`).
 */
export const ANTHROPIC_SERVER_TOOL_BLOCK_TYPES = Object.freeze({
  serverToolUse: 'server_tool_use',
  webSearchToolResult: 'web_search_tool_result',
  webFetchToolResult: 'web_fetch_tool_result',
} as const);

/**
 * Union of all raw content block types that can be returned by server tools.
 * These blocks need to be preserved in conversation context for follow-up messages.
 *
 * - Anthropic: ServerToolUseBlock (the call), WebSearchToolResultBlock, and
 *   WebFetchToolResultBlock (the results)
 * - OpenAI: ResponseFunctionWebSearch (combined call/result) and ResponseReasoningItem
 *   (reasoning items must be included when web_search_call references them)
 */
export type ServerToolContentBlock =
  | ServerToolUseBlock
  | WebSearchToolResultBlock
  | WebFetchToolResultBlock
  | ResponseFunctionWebSearch
  | ResponseReasoningItem;

/**
 * Combined result from server tool extraction.
 * Single source of truth for both display (webSearchResults/webFetchResults)
 * and context (contentBlocks).
 */
export interface ServerToolExtractionResult {
  /** Normalized web search results for display in progress view */
  webSearchResults: WebSearchResult[];
  /** Normalized web fetch results for display in progress view */
  webFetchResults: WebFetchResult[];
  /** Raw content blocks to preserve in conversation context */
  contentBlocks: ServerToolContentBlock[];
}

// ============================================================================
// Type Guards - Using SDK types for better type safety
// ============================================================================

/** Shared shape check: a non-null object whose `type` matches the given tag. */
function hasBlockType(value: unknown, type: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: string }).type === type
  );
}

/** Type guard for Anthropic server tool use block. */
export function isAnthropicServerToolUse(
  block: unknown,
): block is ServerToolUseBlock {
  return hasBlockType(block, ANTHROPIC_SERVER_TOOL_BLOCK_TYPES.serverToolUse);
}

/** Type guard for Anthropic web search result block. */
export function isAnthropicWebSearchResult(
  block: unknown,
): block is WebSearchToolResultBlock {
  return hasBlockType(
    block,
    ANTHROPIC_SERVER_TOOL_BLOCK_TYPES.webSearchToolResult,
  );
}

/** Type guard for Anthropic web fetch result block. */
export function isAnthropicWebFetchResult(
  block: unknown,
): block is WebFetchToolResultBlock {
  return hasBlockType(
    block,
    ANTHROPIC_SERVER_TOOL_BLOCK_TYPES.webFetchToolResult,
  );
}

/** Type guard for OpenAI web search call. */
export function isOpenAIWebSearchCall(
  item: unknown,
): item is ResponseFunctionWebSearch {
  return hasBlockType(item, 'web_search_call');
}

/**
 * Type guard for OpenAI reasoning item.
 * Reasoning items must be preserved when web_search_call references them.
 */
export function isOpenAIReasoningItem(
  item: unknown,
): item is ResponseReasoningItem {
  return hasBlockType(item, 'reasoning');
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
 * Checks if a block is a server tool use, web search result, or web fetch result.
 * Used to identify content that needs to be preserved in conversation context.
 */
export function isAnthropicServerToolContent(
  block: unknown,
): block is
  ServerToolUseBlock | WebSearchToolResultBlock | WebFetchToolResultBlock {
  return (
    isAnthropicServerToolUse(block) ||
    isAnthropicWebSearchResult(block) ||
    isAnthropicWebFetchResult(block)
  );
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
 * Map a web_search_tool_result block's content to normalized result entries.
 * Shared by the streaming (AnthropicStreamHandler) and batch
 * (extractAnthropicWebSearchResults) extraction paths.
 */
export function mapAnthropicWebSearchEntries(
  content: WebSearchToolResultBlock['content'],
): WebSearchResultEntry[] {
  if (!isWebSearchResultArray(content)) {
    return [];
  }
  return content
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
}

/**
 * Map tool_use_id to one input field of the matching `server_tool_use` calls,
 * so a result block can be correlated back to the query or URL that produced
 * it. Blocks whose field is absent or empty are left out of the map.
 */
function serverToolInputMap(
  content: unknown[],
  toolName: string,
  field: 'query' | 'url',
): Map<string, string> {
  const inputs = new Map<string, string>();
  for (const block of content) {
    if (isAnthropicServerToolUse(block) && block.name === toolName) {
      const input = block.input as
        Record<string, string | undefined> | undefined;
      const value = input?.[field];
      if (value) {
        inputs.set(block.id, value);
      }
    }
  }
  return inputs;
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
  const queryMap = serverToolInputMap(content, 'web_search', 'query');
  const results: WebSearchResult[] = [];

  for (const block of content) {
    if (!isAnthropicWebSearchResult(block)) {
      continue;
    }

    const entries = mapAnthropicWebSearchEntries(block.content);
    if (entries.length === 0) {
      continue;
    }

    results.push({
      query: queryMap.get(block.tool_use_id) ?? '',
      results: entries,
      provider: 'anthropic',
      callId: block.tool_use_id,
      status: 'completed',
    });
  }

  return results;
}

/**
 * Type guard for WebFetchBlock (successful fetch) content.
 * The SDK's WebFetchToolResultBlock.content is a union of error or fetch result.
 */
function isWebFetchBlock(content: unknown): content is WebFetchBlock {
  return hasBlockType(content, 'web_fetch_result');
}

/**
 * Cap on the fetched page text stored on a `WebFetchResult` row (#7508): the
 * transcript sidecar is a completed-run archive fact, not working model
 * context, so this stays far below a typical context window while still
 * giving the archived conversation / chat export meaningful content instead
 * of none.
 */
const MAX_WEB_FETCH_CONTENT_CHARS = 20_000;

/** Truncate fetched page text to {@link MAX_WEB_FETCH_CONTENT_CHARS}. */
function capWebFetchContent(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const marker = '...';
  return text.length > MAX_WEB_FETCH_CONTENT_CHARS
    ? `${text.slice(0, MAX_WEB_FETCH_CONTENT_CHARS - marker.length)}${marker}`
    : text;
}

/**
 * Extract the fetched document's plain text, when the provider returned one
 * (`PlainTextSource`) rather than binary content (e.g. a fetched PDF's
 * `Base64PDFSource`, which this deliberately does not surface as text).
 * Shared by the batch ({@link extractAnthropicWebFetchResults}) and streaming
 * (`AnthropicStreamHandler`) extraction paths.
 */
function extractWebFetchPageText(
  content: WebFetchBlock['content'] | undefined,
): string | undefined {
  return content?.source?.type === 'text' ? content.source.data : undefined;
}

/** Fields used by conversation formatting and structured chat export. */
interface WebFetchResultFields {
  readonly url?: string;
  readonly title?: string;
  readonly content?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function webFetchBlockFields(result: WebFetchBlock): WebFetchResultFields {
  return {
    url: optionalString(result.url),
    title: optionalString(result.content?.title),
    content: capWebFetchContent(
      optionalString(extractWebFetchPageText(result.content)),
    ),
  };
}

/**
 * Read a web-fetch result from either Anthropic's live nested block or the
 * flat block reconstructed by the completed-run archive.
 */
export function extractWebFetchResultFields(
  block: unknown,
): WebFetchResultFields | undefined {
  if (!isObject(block)) return undefined;

  const fields = isWebFetchBlock(block.content)
    ? webFetchBlockFields(block.content)
    : {
        url: optionalString(block.url),
        title: optionalString(block.title),
        content: capWebFetchContent(optionalString(block.page_content)),
      };

  return fields.url !== undefined ||
    fields.title !== undefined ||
    fields.content !== undefined
    ? fields
    : undefined;
}

/**
 * Extract web fetch results from Anthropic response content.
 * Uses SDK's WebFetchToolResultBlock type.
 * Correlates server_tool_use blocks (which contain the URL) with
 * web_fetch_tool_result blocks (which contain the fetched content).
 */
export function extractAnthropicWebFetchResults(
  content: unknown[],
): WebFetchResult[] {
  const urlMap = serverToolInputMap(content, 'web_fetch', 'url');
  const results: WebFetchResult[] = [];

  for (const block of content) {
    if (!isAnthropicWebFetchResult(block)) {
      continue;
    }

    const fetchUrl = urlMap.get(block.tool_use_id) ?? '';

    if (isWebFetchBlock(block.content)) {
      // Successful fetch
      const fields = extractWebFetchResultFields(block);
      results.push({
        url: fields?.url || fetchUrl,
        title: fields?.title,
        provider: 'anthropic',
        callId: block.tool_use_id,
        status: 'completed',
        content: fields?.content,
      });
    } else {
      // Error result — block.content is narrowed to WebFetchToolResultErrorBlock
      results.push({
        url: fetchUrl,
        provider: 'anthropic',
        callId: block.tool_use_id,
        status: 'failed',
        errorCode: block.content.error_code,
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

  // Determine status using SDK's status type. 'completed' and 'failed' map
  // through directly; any other SDK status is reported as in-progress.
  const status: WebSearchResult['status'] =
    searchItem.status === 'completed' || searchItem.status === 'failed'
      ? searchItem.status
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
  return output.filter(isOpenAIWebSearchCall).map(buildOpenAIWebSearchResult);
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Extract domain from URL.
 */
function extractDomain(url: string): string {
  const parsed = tryParseUrl(url);
  if (parsed) return parsed.hostname;
  // Contract: return '' for unparseable URLs. Log so malformed source data
  // isn't silently rendered as an empty domain.
  logger.debug('ServerTools', `extractDomain: unparseable URL "${url}"`);
  return '';
}
