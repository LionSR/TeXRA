// Third-party imports
import type {
  Usage as AnthropicUsage,
  CacheCreation,
  ServerToolUsage,
} from '@anthropic-ai/sdk/resources/messages';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import type { CompletionUsage } from 'openai/resources/completions';
import type { ResponseUsage as OpenAIResponseUsage } from 'openai/resources/responses/responses';

/**
 * Extended OpenAI usage type with additional fields used by various providers.
 *
 * This interface extends the `CompletionUsage` type from the OpenAI SDK to include
 * additional metrics required by DeepSeek and other providers.
 *
 * Fields:
 * - `prompt_cache_hit_tokens` (optional): Represents the number of tokens retrieved
 *   from the prompt cache during a completion request. This is specific to DeepSeek's
 *   caching mechanism, which aims to optimize performance by reusing previously
 *   processed prompts. A higher value indicates greater cache utilization.
 */
export interface ExtendedCompletionUsage extends CompletionUsage {
  prompt_cache_hit_tokens?: number;
}

/**
 * Union of native usage payloads from different providers.
 * This is the raw usage object returned by each provider's API.
 *
 * - ExtendedCompletionUsage: OpenAI Chat Completions API (includes DeepSeek extension)
 * - OpenAIResponseUsage: OpenAI Responses API
 * - AnthropicUsage: Anthropic Messages API
 * - GenerateContentResponseUsageMetadata: Google Gemini API
 */
export type NativeUsagePayload =
  | ExtendedCompletionUsage
  | OpenAIResponseUsage
  | AnthropicUsage
  | GenerateContentResponseUsageMetadata;

/**
 * Provider usage type for API responses.
 * Same as NativeUsagePayload but allows null/undefined for cases where
 * the provider doesn't return usage data.
 */
export type ProviderUsage = NativeUsagePayload | null | undefined;

// Re-export SDK types for use in model handlers
export type {
  CompletionUsage,
  AnthropicUsage,
  CacheCreation,
  ServerToolUsage,
  GenerateContentResponseUsageMetadata,
  OpenAIResponseUsage,
};

/** Base interface for common response usage metrics. Internal only. */
interface ResponseUsageBase {
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
  // Some providers expose tool-use tokens via the OpenAI-compatible interface.
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
  /** Breakdown of cache creation tokens by TTL (5m vs 1h) */
  cache_creation: CacheCreation | null;
  /** Server tool usage statistics (e.g., web search requests) */
  server_tool_use: ServerToolUsage | null;
  /** Service tier used for the request (standard, priority, or batch) */
  service_tier: 'standard' | 'priority' | 'batch' | null;
  // Optional field surfaced by compatibility layers that expose tool-use costs.
  tool_use_tokens?: number;
}
