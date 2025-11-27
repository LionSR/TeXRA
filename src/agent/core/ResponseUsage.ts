// Third-party imports
import type {
  Usage as AnthropicUsage,
  CacheCreation,
  ServerToolUsage,
} from '@anthropic-ai/sdk/resources/messages';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import type { CompletionUsage } from 'openai/resources/completions';

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

// Re-export SDK types for use in model handlers
export type {
  CompletionUsage,
  AnthropicUsage,
  CacheCreation,
  ServerToolUsage,
  GenerateContentResponseUsageMetadata,
};

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

/** Factory class for creating provider-specific response usage objects. */
export class ResponseUsageFactory {
  /**
   * Creates an OpenAI usage object from API response data.
   * @param responseUsage Raw usage data from OpenAI API
   * @param cost Calculated cost in USD
   * @param responseTime Response time in milliseconds
   * @returns Structured OpenAI usage metrics
   */
  static fromOpenAIResponse(
    responseUsage: ExtendedCompletionUsage,
    cost: number,
    responseTime: number,
  ): OpenAIAPIResponseUsage {
    // Extract tokens from response usage
    const promptTokensDetails = responseUsage.prompt_tokens_details;
    const cachedTokens = promptTokensDetails?.cached_tokens ?? 0;

    // Extract completion details
    const completionDetails = responseUsage.completion_tokens_details;
    const reasoningTokens = completionDetails?.reasoning_tokens ?? 0;
    const acceptedPredictionTokens =
      completionDetails?.accepted_prediction_tokens ?? null;
    const rejectedPredictionTokens =
      completionDetails?.rejected_prediction_tokens ?? null;

    // Calculate percentage cached
    const percentageCached =
      responseUsage.prompt_tokens > 0
        ? (cachedTokens / responseUsage.prompt_tokens) * 100
        : 0;

    return {
      // Base fields
      totalInputTokens: responseUsage.prompt_tokens,
      totalOutputTokens: responseUsage.completion_tokens,
      percentageCached,
      cost,
      responseTime,
      // OpenAI specific fields (keeping snake_case)
      prompt_tokens: responseUsage.prompt_tokens,
      completion_tokens: responseUsage.completion_tokens,
      cached_tokens: cachedTokens,
      reasoning_tokens: reasoningTokens,
      accepted_prediction_tokens: acceptedPredictionTokens,
      rejected_prediction_tokens: rejectedPredictionTokens,
    };
  }

  /**
   * Creates an Anthropic usage object from API response data.
   * @param responseUsage Raw usage data from Anthropic API
   * @param cost Calculated cost in USD
   * @param responseTime Response time in milliseconds
   * @returns Structured Anthropic usage metrics
   */
  static fromAnthropicResponse(
    responseUsage: AnthropicUsage,
    cost: number,
    responseTime: number,
  ): AnthropicAPIResponseUsage {
    // Extract cache-related tokens
    const cacheReadInputTokens = responseUsage.cache_read_input_tokens ?? null;
    const cacheCreationInputTokens =
      responseUsage.cache_creation_input_tokens ?? null;

    // Calculate percentage cached
    const totalCacheTokens =
      (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0);
    const percentageCached =
      responseUsage.input_tokens > 0
        ? (totalCacheTokens / responseUsage.input_tokens) * 100
        : 0;

    return {
      // Base fields
      totalInputTokens: responseUsage.input_tokens,
      totalOutputTokens: responseUsage.output_tokens,
      percentageCached,
      cost,
      responseTime,
      // Anthropic specific fields (keeping snake_case to match SDK)
      input_tokens: responseUsage.input_tokens,
      output_tokens: responseUsage.output_tokens,
      cache_read_input_tokens: cacheReadInputTokens,
      cache_creation_input_tokens: cacheCreationInputTokens,
      cache_creation: responseUsage.cache_creation ?? null,
      server_tool_use: responseUsage.server_tool_use ?? null,
      service_tier: responseUsage.service_tier ?? null,
    };
  }
}
