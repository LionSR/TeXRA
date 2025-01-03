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
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  acceptedPredictionTokens: number | null;
  rejectedPredictionTokens: number | null;
}

/**
 * Anthropic response usage statistics.
 */
export interface AnthropicAPIResponseUsage extends ResponseUsageBase {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
}

/**
 * Factory functions for creating response usage objects
 */
export class ResponseUsageFactory {
  static fromOpenAIResponse(
    responseUsage: any,
    cost: number,
    responseTime: number,
  ): OpenAIAPIResponseUsage {
    const cachedTokens =
      responseUsage.prompt_tokens_details?.cached_tokens ?? 0;
    const completionDetails = responseUsage.completion_tokens_details;
    const reasoningTokens = completionDetails?.reasoning_tokens ?? 0;
    const acceptedPredictionTokens =
      completionDetails?.accepted_prediction_tokens ?? null;
    const rejectedPredictionTokens =
      completionDetails?.rejected_prediction_tokens ?? null;

    const percentageCached =
      responseUsage.prompt_tokens > 0
        ? (cachedTokens / responseUsage.prompt_tokens) * 100
        : 0;

    return {
      totalInputTokens: responseUsage.prompt_tokens,
      totalOutputTokens: responseUsage.completion_tokens,
      promptTokens: responseUsage.prompt_tokens,
      completionTokens: responseUsage.completion_tokens,
      cachedTokens,
      reasoningTokens,
      acceptedPredictionTokens,
      rejectedPredictionTokens,
      percentageCached,
      cost,
      responseTime,
    };
  }

  static fromAnthropicResponse(
    responseUsage: any,
    cost: number,
    responseTime: number,
  ): AnthropicAPIResponseUsage {
    const cacheReadInputTokens = responseUsage.cache_read_input_tokens ?? null;
    const cacheCreationInputTokens =
      responseUsage.cache_creation_input_tokens ?? null;

    const totalCacheTokens =
      (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0);
    const percentageCached =
      responseUsage.input_tokens > 0
        ? (totalCacheTokens / responseUsage.input_tokens) * 100
        : 0;

    return {
      totalInputTokens: responseUsage.input_tokens,
      totalOutputTokens: responseUsage.output_tokens,
      inputTokens: responseUsage.input_tokens,
      outputTokens: responseUsage.output_tokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      percentageCached,
      cost,
      responseTime,
    };
  }
}
