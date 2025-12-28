/**
 * Shared types and schemas for unified streaming.
 *
 * This module provides:
 * - Zod schemas for validation
 * - TypeScript types derived from schemas
 * - Utility types for normalizer implementations
 */

import { z } from 'zod';

import type { UsageProvider } from '@agent/types/NormalizedUsage';

// ============================================================================
// Web Search Types (mirrored from ServerToolTypes for schema validation)
// ============================================================================

/**
 * A single web search result entry.
 * Schema version of WebSearchResultEntry from ServerToolTypes.
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

export type WebSearchResultEntry = z.infer<typeof WebSearchResultEntrySchema>;

// ============================================================================
// Normalizer Configuration Types
// ============================================================================

/**
 * Options passed to stream normalizers.
 * Controls what events are emitted and how they're processed.
 */
export interface NormalizerOptions {
  /**
   * Whether to emit content events.
   * Set to false when output streaming is disabled.
   */
  outputEnabled?: boolean;

  /**
   * Whether progress view streaming is enabled.
   * Affects whether events should be emitted for UI updates.
   */
  progressViewEnabled?: boolean;

  /**
   * Provider identifier for usage normalization.
   */
  provider?: UsageProvider;

  /**
   * Model name for provider-specific behavior.
   */
  modelName?: string;

  /**
   * Start time for response time calculation.
   */
  startTime?: number;
}

// ============================================================================
// Normalizer State Types
// ============================================================================

/**
 * State tracked during Anthropic stream normalization.
 * Handles interleaved content blocks and web search accumulation.
 */
export interface AnthropicNormalizerState {
  /** Index of the last processed block */
  lastBlockIndex: number;

  /** Current thinking block index (null if not in thinking) */
  currentThinkingIndex: number | null;

  /** Current text block index (null if not in text) */
  currentTextBlockIndex: number | null;

  /** Pending web searches (by tool_use_id) */
  pendingSearches: Map<string, { index: number; input: string }>;

  /** Emitted search IDs (for deduplication) */
  emittedSearchIds: Set<string>;

  /** Accumulated thinking text */
  thinkingBuffer: string;

  /** Accumulated content text */
  contentBuffer: string;
}

/**
 * State tracked during OpenAI stream normalization.
 * Handles tool call reconstruction from indexed fragments.
 */
export interface OpenAINormalizerState {
  /** Active tool calls being reconstructed */
  toolCalls: Map<
    number,
    {
      id: string;
      name: string;
      arguments: string;
    }
  >;

  /** Accumulated thinking/reasoning text */
  thinkingBuffer: string;

  /** Accumulated content text */
  contentBuffer: string;

  /** Whether we've seen any chunks */
  hasChunks: boolean;
}

/**
 * State tracked during Google stream normalization.
 * Handles delta calculation from cumulative chunks and response aggregation.
 *
 * Note: Google's SDK doesn't provide a finalResponse() method like OpenAI/Anthropic,
 * so we must manually aggregate parts across all chunks to reconstruct the full response.
 */
export interface GoogleNormalizerState {
  /** Previous thinking text (for delta calculation) */
  previousThinkingText: string;

  /** Previous content text (for delta calculation) */
  previousContentText: string;

  /** Previous thinking block index */
  previousThinkingIndex: number;

  /** Previous content block index */
  previousContentIndex: number;

  /** Seen tool call IDs */
  seenToolCallIds: Set<string>;

  // --- Aggregation state (Google SDK lacks built-in aggregation) ---

  /** Base response from first chunk (metadata foundation) */
  baseResponse: unknown | null;

  /** All parts accumulated from all chunks */
  aggregatedParts: unknown[];

  /** Latest candidate (for finishReason, etc.) */
  latestCandidate: unknown | null;

  /** Latest usage metadata from chunks */
  usageFromChunks: unknown | null;
}

/**
 * State tracked during OpenAI Response API normalization.
 * Handles interleaved events and background mode.
 */
export interface OpenAIResponseNormalizerState {
  /** Whether we're currently in a thinking block */
  hasThinkingContent: boolean;

  /** Emitted web search IDs (for deduplication) */
  emittedWebSearchIds: Set<string>;

  /** Accumulated thinking text */
  thinkingBuffer: string;

  /** Accumulated content text */
  contentBuffer: string;
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Async generator type for normalized streams.
 * All normalizers return this type.
 */
export type NormalizedStream = AsyncGenerator<
  import('./streamEventSchema').StreamEvent,
  void,
  undefined
>;

/**
 * Normalizer function signature.
 * Transforms provider-specific streams to normalized events.
 */
export type StreamNormalizer<TStream> = (
  stream: TStream,
  options: NormalizerOptions,
) => NormalizedStream;

// ============================================================================
// Result Types
// ============================================================================

/**
 * Result of consuming a normalized stream.
 * Contains the final response and any accumulated data.
 */
export interface StreamConsumptionResult {
  /** Final normalized response */
  response: import('./streamEventSchema').NormalizedResponse;

  /** Whether any thinking content was emitted */
  hadThinking: boolean;

  /** Whether any content was emitted */
  hadContent: boolean;

  /** Number of tool calls received */
  toolCallCount: number;

  /** Number of web searches received */
  webSearchCount: number;
}
