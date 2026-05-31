/**
 * OpenAI (and OpenAI-compatible) usage accounting & pricing.
 *
 * Pure functions extracted from `ModelHandlerOpenAI` so token accounting and
 * cache-aware price computation can be reasoned about and unit-tested without a
 * live handler instance. The handler keeps thin `computePrice` / `normalizeUsage`
 * overrides that delegate here with the model's pricing config and provider id.
 */
import type { ExtendedCompletionUsage } from '@agent/core/usage/ResponseUsage';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { calculateTokenPrice } from '@agent/utils/priceUtils';

import { normalizeUsage } from '../support/UsageNormalizer';

/** Pricing inputs the handler supplies from its `config`/`capabilities`. */
export interface OpenAIPricingConfig {
  inputPrice: number;
  outputPrice: number;
  cacheDiscountFactor: number;
}

/** Computes cost based on token usage and model pricing. */
export function computeOpenAIPrice(
  responseUsage: ExtendedCompletionUsage | null,
  config: OpenAIPricingConfig,
): number {
  if (!responseUsage) return 0;

  const cachedTokens =
    responseUsage.prompt_tokens_details?.cached_tokens ??
    responseUsage.prompt_cache_hit_tokens ??
    0;
  const promptTokens =
    responseUsage.prompt_tokens ??
    cachedTokens + (responseUsage.prompt_cache_miss_tokens ?? 0);
  const completionTokens = responseUsage.completion_tokens ?? 0;
  // Note: OpenAI doesn't provide tool_use_tokens in their API response

  let basePrice = calculateTokenPrice(
    promptTokens,
    completionTokens,
    config.inputPrice,
    config.outputPrice,
  );

  // Retrieve nested token details if present
  const reasoningTokens =
    responseUsage.completion_tokens_details?.reasoning_tokens ?? 0;
  if (reasoningTokens) {
    basePrice += (reasoningTokens * config.outputPrice) / 1e6;
  }
  if (cachedTokens) {
    basePrice -=
      (cachedTokens * config.inputPrice * (1 - config.cacheDiscountFactor)) /
      1e6;
  }

  return basePrice;
}

/** Normalizes OpenAI usage data into a unified format. */
export function normalizeOpenAIUsage(
  rawUsage: ExtendedCompletionUsage | null,
  responseTimeMs: number,
  provider: NormalizedUsage['provider'],
  config: OpenAIPricingConfig,
): NormalizedUsage {
  return normalizeUsage(
    {
      provider,
      computePrice: (usage) => computeOpenAIPrice(usage, config),
      extract: (usage) => {
        // OpenAI: prompt_tokens_details.cached_tokens; DeepSeek: prompt_cache_hit_tokens
        const cachedTokens =
          usage.prompt_tokens_details?.cached_tokens ??
          usage.prompt_cache_hit_tokens ??
          0;
        const cacheMissTokens = usage.prompt_cache_miss_tokens ?? 0;

        // OpenAI's prompt_tokens is the TOTAL (includes cached tokens). DeepSeek
        // also exposes cache hit/miss fields; use their sum as a fallback if
        // prompt_tokens is absent from an OpenAI-compatible response.
        const inputTokens =
          usage.prompt_tokens ??
          (cachedTokens > 0 || cacheMissTokens > 0
            ? cachedTokens + cacheMissTokens
            : 0);

        return {
          inputTokens,
          outputTokens: usage.completion_tokens ?? 0,
          cachedTokens,
          cacheMissTokens,
          reasoningTokens:
            usage.completion_tokens_details?.reasoning_tokens ?? 0,
        };
      },
    },
    rawUsage,
    responseTimeMs,
  );
}
