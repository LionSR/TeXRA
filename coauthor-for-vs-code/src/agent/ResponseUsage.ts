/**
 * Data structures for response usage statistics.
 */

/**
 * Base interface for response usage statistics.
 */
export interface ResponseUsageBase {
  totalInputTokens: number;
  totalOutputTokens: number;
  percentageCached: number;
  cost: number;
  responseTime: number;
}

/**
 * OpenAI response usage statistics.
 */
export interface OpenAIAPIResponseUsage extends ResponseUsageBase {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  accepted_prediction_tokens: number | null;
  rejected_prediction_tokens: number | null;
}

/**
 * Anthropic response usage statistics.
 */
export interface AnthropicAPIResponseUsage extends ResponseUsageBase {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
}

/**
 * Factory functions for creating response usage objects
 */
export class ResponseUsageFactory {
  /**
   * Create OpenAI response usage object from API response
   */
  static fromOpenAIResponse(
    responseUsage: any,
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
   * Create Anthropic response usage object from API response
   */
  static fromAnthropicResponse(
    responseUsage: any,
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
      // Anthropic specific fields (keeping snake_case)
      input_tokens: responseUsage.input_tokens,
      output_tokens: responseUsage.output_tokens,
      cache_read_input_tokens: cacheReadInputTokens,
      cache_creation_input_tokens: cacheCreationInputTokens,
    };
  }
}
