/**
 * Unified types for server-side (native) tool results across providers.
 *
 * Server tools are executed by the provider (Anthropic, OpenAI, Google) rather
 * than locally. This module provides a unified abstraction layer.
 *
 * Uses native SDK types where available for better type safety and maintainability.
 */

// SDK type imports - using native types for better type safety
import type {
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  WebSearchResultBlock,
} from '@anthropic-ai/sdk/resources/messages';
import type { ResponseFunctionWebSearch } from 'openai/resources/responses/responses';

// Re-export SDK types for external use
export type {
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  WebSearchResultBlock,
  ResponseFunctionWebSearch,
};

// ============================================================================
// Web Search Result Types
// ============================================================================

/**
 * A single web search result entry.
 * Normalized across all providers.
 */
export interface WebSearchResultEntry {
  /** URL of the search result */
  url: string;
  /** Title of the page */
  title: string;
  /** Text snippet/description (may be encrypted for Anthropic) */
  snippet?: string;
  /** Domain extracted from URL */
  domain?: string;
  /** Page age/freshness hint (Anthropic only) */
  pageAge?: string;
}

/**
 * Unified web search result across all providers.
 */
export interface WebSearchResult {
  /** The search query that was executed */
  query: string;
  /** Search result entries */
  results: WebSearchResultEntry[];
  /** Provider that executed the search */
  provider: 'anthropic' | 'openai' | 'google';
  /** Unique identifier for this search call */
  callId?: string;
  /** Status of the search */
  status: 'completed' | 'in_progress' | 'failed';
}

// ============================================================================
// Server Tool Call Types (Discriminated Union)
// ============================================================================

/**
 * Anthropic server tool use block.
 * Represents a tool executed by Anthropic's servers.
 */
export interface AnthropicServerToolCall {
  provider: 'anthropic';
  type: 'web_search';
  callId: string;
  name: 'web_search';
  /** Raw SDK block for reference */
  raw: unknown;
}

/**
 * OpenAI web search call from Responses API.
 */
export interface OpenAIWebSearchCall {
  provider: 'openai';
  type: 'web_search_call';
  callId: string;
  /** Search query */
  query?: string;
  /** Sources/URLs found */
  sources?: Array<{ type: 'url'; url: string }>;
  status: 'in_progress' | 'searching' | 'completed' | 'failed';
  /** Raw SDK object for reference */
  raw: unknown;
}

/**
 * Google grounding metadata from search.
 */
export interface GoogleGroundingResult {
  provider: 'google';
  type: 'grounding';
  /** Grounding chunks with web sources */
  chunks: Array<{
    title?: string;
    uri?: string;
    domain?: string;
  }>;
  /** Queries that were executed */
  searchQueries?: string[];
  /** Raw SDK metadata for reference */
  raw: unknown;
}

/**
 * Union of all server tool call types.
 */
export type ServerToolCall =
  | AnthropicServerToolCall
  | OpenAIWebSearchCall
  | GoogleGroundingResult;

/**
 * Combined result from server tool extraction.
 * Single source of truth for both display (webSearchResults) and context (contentBlocks).
 */
export interface ServerToolExtractionResult {
  /** Normalized web search results for display in progress view */
  webSearchResults: WebSearchResult[];
  /** Raw content blocks to preserve in conversation context */
  contentBlocks: unknown[];
}

// ============================================================================
// Type Guards - Using SDK types for better type safety
// ============================================================================

/**
 * Check if a server tool call is a web search (any provider).
 */
export function isWebSearchCall(call: ServerToolCall): boolean {
  return (
    call.type === 'web_search' ||
    call.type === 'web_search_call' ||
    call.type === 'grounding'
  );
}

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
 */
export function extractAnthropicWebSearchResults(
  content: unknown[],
): WebSearchResult[] {
  const results: WebSearchResult[] = [];

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
      .filter((r): r is WebSearchResultBlock => r.type === 'web_search_result' && !!r.url)
      .map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.encrypted_content,
        pageAge: r.page_age ?? undefined,
        domain: extractDomain(r.url),
      }));

    if (entries.length > 0) {
      results.push({
        query: '', // Anthropic doesn't expose query in result
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
interface ResponseFunctionWebSearchWithAction extends ResponseFunctionWebSearch {
  action?: ResponseFunctionWebSearch.Search;
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

    // item is now properly typed as ResponseFunctionWebSearch
    // Cast to extended type that may include action field
    const searchItem = item as ResponseFunctionWebSearchWithAction;

    // Determine status using SDK's status type
    const status: WebSearchResult['status'] =
      searchItem.status === 'completed'
        ? 'completed'
        : searchItem.status === 'failed'
          ? 'failed'
          : 'in_progress';

    // Handle case when action is not present (default API response)
    const action = searchItem.action;
    if (!action) {
      // Web search occurred but sources not included in response
      // Return a result indicating the search happened
      results.push({
        query: '',
        results: [],
        provider: 'openai',
        callId: searchItem.id,
        status,
      });
      continue;
    }

    // Handle case when action is present (include sources was used)
    // action.type is always 'search' per SDK's ResponseFunctionWebSearch.Search
    const entries: WebSearchResultEntry[] = (action.sources ?? []).map((s) => ({
      url: s.url,
      title: '', // OpenAI sources don't include titles in basic response
      domain: extractDomain(s.url),
    }));

    results.push({
      query: action.query ?? '',
      results: entries,
      provider: 'openai',
      callId: searchItem.id,
      status,
    });
  }

  return results;
}

/**
 * Extract grounding results from Google GenAI response.
 */
export function extractGoogleGroundingResults(
  candidate: unknown,
): WebSearchResult | null {
  const cand = candidate as {
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: { title?: string; uri?: string; domain?: string };
      }>;
      webSearchQueries?: string[];
      retrievalQueries?: string[];
    };
  };

  const metadata = cand?.groundingMetadata;
  if (!metadata?.groundingChunks?.length) {
    return null;
  }

  const entries: WebSearchResultEntry[] = metadata.groundingChunks
    .filter((chunk) => chunk.web?.uri)
    .map((chunk) => ({
      url: chunk.web!.uri!,
      title: chunk.web!.title ?? '',
      domain: chunk.web!.domain ?? extractDomain(chunk.web!.uri!),
    }));

  if (entries.length === 0) {
    return null;
  }

  const queries = metadata.webSearchQueries ?? metadata.retrievalQueries ?? [];

  return {
    query: queries.join('; '),
    results: entries,
    provider: 'google',
    status: 'completed',
  };
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Extract domain from URL.
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Format web search results for display/logging.
 */
export function formatWebSearchResults(result: WebSearchResult): string {
  const lines: string[] = [];

  if (result.query) {
    lines.push(`Search: "${result.query}"`);
  }

  lines.push(`Provider: ${result.provider}`);
  lines.push(`Results: ${result.results.length}`);
  lines.push('');

  for (const entry of result.results) {
    lines.push(`• ${entry.title || entry.domain || 'Untitled'}`);
    lines.push(`  ${entry.url}`);
    if (entry.snippet) {
      lines.push(`  ${entry.snippet.slice(0, 100)}...`);
    }
  }

  return lines.join('\n');
}
