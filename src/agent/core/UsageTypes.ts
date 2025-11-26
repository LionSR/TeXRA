/**
 * @file UsageTypes.ts
 *
 * Consolidated usage and token statistics types.
 * This is the single source of truth for all usage-related type definitions.
 *
 * Types are organized into three categories:
 * 1. Display types - For UI/logging (TokenUsageStats, ExtendedTokenUsageStats)
 * 2. Provider types - Raw API response structures (ResponseUsageBase, provider-specific)
 * 3. Accumulation types - For tracking during execution (RunUsageTotals, NativeUsageSnapshot)
 */
// Third-party imports
import { z } from 'zod';

// SDK type imports for provider-specific usage
import type { Usage as AnthropicUsage } from '@anthropic-ai/sdk/resources/messages';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import type { CompletionUsage } from 'openai/resources/completions';

// =============================================================================
// SDK Type Re-exports
// =============================================================================

/**
 * Extended OpenAI usage type with additional fields used by various providers.
 * Includes DeepSeek's prompt_cache_hit_tokens for caching metrics.
 */
export interface ExtendedCompletionUsage extends CompletionUsage {
  prompt_cache_hit_tokens?: number;
}

// Re-export SDK types for use in model handlers
export type {
  CompletionUsage,
  AnthropicUsage,
  GenerateContentResponseUsageMetadata,
};

// =============================================================================
// Display Types (UI/Logging)
// =============================================================================

/**
 * Token usage statistics for tracking model usage and costs.
 * Used for displaying aggregated stats in the UI.
 */
export const TokenUsageStatsSchema = z.strictObject({
  /** Number of input tokens consumed */
  inputTokens: z.number(),
  /** Number of output tokens generated */
  outputTokens: z.number(),
  /** Total cost in USD for the request */
  cost: z.number(),
});

export type TokenUsageStats = z.infer<typeof TokenUsageStatsSchema>;

/**
 * Extended statistics tracked during agent execution.
 * Includes cache metrics, reasoning tokens, and timing information.
 */
export interface ExtendedTokenUsageStats extends TokenUsageStats {
  /** Total elapsed time in seconds */
  elapsedTime?: number;
  /** Tokens read from cache */
  cacheReadInputTokens?: number;
  /** Tokens written to cache */
  cacheCreationInputTokens?: number;
  /** Percentage of tokens served from cache */
  percentageCached?: number;
  /** Tokens used for reasoning */
  reasoningTokens?: number;
  /** Tokens consumed by tool use */
  toolUseTokens?: number;
}

/**
 * Message interface for updating usage stats in the progress view.
 */
export const StreamUsageMessageSchema = z.strictObject({
  command: z.literal('updateUsage'),
  stream: z.string(),
  usageByRun: z.record(z.string(), TokenUsageStatsSchema).prefault({}),
});

export type StreamUsageMessage = z.infer<typeof StreamUsageMessageSchema>;

// =============================================================================
// Provider Response Types
// =============================================================================

/** Base interface for common response usage metrics across all model providers. */
export interface ResponseUsageBase {
  totalInputTokens: number;
  totalOutputTokens: number;
  percentageCached: number;
  cost: number;
  responseTime: number;
}

/** OpenAI-specific response usage metrics with detailed token breakdowns. */
export interface OpenAIAPIResponseUsage extends ResponseUsageBase {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  accepted_prediction_tokens: number | null;
  rejected_prediction_tokens: number | null;
  /** Some providers expose tool-use tokens via the OpenAI-compatible interface. */
  tool_use_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    accepted_prediction_tokens?: number | null;
    rejected_prediction_tokens?: number | null;
  };
}

/** Anthropic-specific response usage metrics with cache statistics. */
export interface AnthropicAPIResponseUsage extends ResponseUsageBase {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  /** Optional field surfaced by compatibility layers that expose tool-use costs. */
  tool_use_tokens?: number;
}

// =============================================================================
// Accumulation Types (Runtime Tracking)
// =============================================================================

/** Union of native usage payloads from different providers. */
export type NativeUsagePayload =
  | ExtendedCompletionUsage
  | AnthropicUsage
  | GenerateContentResponseUsageMetadata;

/** Union of provider-specific usage summaries. */
export type UsageSummary =
  | OpenAIAPIResponseUsage
  | AnthropicAPIResponseUsage
  | null;

/** Provider identifier for usage tracking. */
export type UsageProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'unknown';

/** Snapshot of native usage data for a single round. */
export interface NativeUsageSnapshot {
  round: number;
  provider: UsageProvider;
  payload: NativeUsagePayload;
}

/** Accumulated usage totals across all rounds. */
export interface RunUsageTotals {
  firstInputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadInputTokens: number;
  totalCacheCreationInputTokens: number;
  totalReasoningTokens: number;
  totalToolUseTokens: number;
}

/** Serializable representation of RunUsageAccumulator state. */
export interface RunUsageAccumulatorJSON {
  totals: RunUsageTotals;
  snapshots: NativeUsageSnapshot[];
}
