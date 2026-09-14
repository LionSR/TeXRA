/**
 * Unified types for server-side (native) tool results across providers.
 *
 * Server tools are executed by the provider (Anthropic, OpenAI) rather than
 * locally. The normalized result type below describes an in-process
 * representation rather than a validation boundary — nothing parses it — so
 * it is declared directly, the same call `@agent/export/schemas` makes for the
 * export IR.
 */

import type {
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  WebFetchToolResultBlock,
} from '@anthropic-ai/sdk/resources/messages';
import type {
  ResponseFunctionWebSearch,
  ResponseReasoningItem,
} from 'openai/resources/responses/responses';

/** A single web search result entry, normalized across all providers. */
type WebSearchResultEntry = {
  /** URL of the search result */
  url: string;
  /** Title of the page */
  title: string;
  /** Domain extracted from URL */
  domain?: string;
};

/** Unified web search result across all providers. */
export type WebSearchResult = {
  /** The search query that was executed */
  query: string;
  /** Search result entries */
  results: WebSearchResultEntry[];
  /** Provider that executed the search */
  provider: 'anthropic' | 'openai';
  /** Unique identifier for this search call */
  callId?: string;
  /** Status of the search */
  status: 'completed' | 'in_progress' | 'failed';
};

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
