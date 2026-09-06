/**
 * OpenAI (and OpenAI-compatible) usage accounting & pricing.
 *
 * Pure functions extracted from `ModelHandlerOpenAI` so token accounting and
 * cache-aware price computation can be reasoned about and unit-tested without a
 * live handler instance. The handler keeps a thin `normalizeUsage` override
 * that delegates here with the model's pricing config and provider id.
 */

import type { ExtendedCompletionUsage } from '@agent/types/ProviderUsage';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import {
  computeStandardPrice,
  type StandardPricingConfig,
} from '@agent/modelHandlers/support/priceUtils';

import { normalizeUsage } from '../support/UsageNormalizer';
import type { ResponseUsage } from 'openai/resources/responses/responses';

/**
 * Cost for the Responses API. Same inclusive-cache formula as
 * {@link normalizeOpenAIUsage}; only the token field names differ
 * (`input_tokens`/`output_tokens` vs `prompt_tokens`/`completion_tokens`).
 */
export function computeOpenAIResponsePrice(
  responseUsage: ResponseUsage,
  config: StandardPricingConfig,
): number {
  return computeStandardPrice(
    {
      inputTokens: responseUsage.input_tokens ?? 0,
      outputTokens: responseUsage.output_tokens ?? 0,
      cachedTokens: responseUsage.input_tokens_details?.cached_tokens ?? 0,
      reasoningTokens:
        responseUsage.output_tokens_details?.reasoning_tokens ?? 0,
    },
    config,
  );
}

/**
 * Normalizes OpenAI Responses API usage into the unified format. Mirrors
 * {@link normalizeOpenAIUsage} but reads the Responses token fields
 * (`input_tokens`/`output_tokens` and their `*_details`). The usage provider
 * comes from the handler (`openai-response` for OpenAI/Codex; other backends
 * on this surface tag their own provider, e.g. `meta`).
 */
export function normalizeOpenAIResponseUsage(
  rawUsage: ResponseUsage,
  responseTimeMs: number,
  provider: NormalizedUsage['provider'],
  computePrice: (usage: ResponseUsage) => number,
): NormalizedUsage {
  if (!rawUsage) return normalizeUsage(provider, responseTimeMs, null);

  return normalizeUsage(provider, responseTimeMs, {
    rawUsage,
    inputTokens: rawUsage.input_tokens ?? 0,
    outputTokens: rawUsage.output_tokens ?? 0,
    cachedTokens: rawUsage.input_tokens_details?.cached_tokens ?? 0,
    cacheCreationTokens: rawUsage.input_tokens_details?.cache_write_tokens ?? 0,
    reasoningTokens: rawUsage.output_tokens_details?.reasoning_tokens ?? 0,
    cost: computePrice(rawUsage),
  });
}

/** Normalizes OpenAI usage data into a unified format. */
export function normalizeOpenAIUsage(
  rawUsage: ExtendedCompletionUsage | null,
  responseTimeMs: number,
  provider: NormalizedUsage['provider'],
  config: StandardPricingConfig,
): NormalizedUsage {
  if (!rawUsage) return normalizeUsage(provider, responseTimeMs, null);

  // OpenAI and DeepSeek expose cached prompt counts under different fields.
  const cachedTokens =
    rawUsage.prompt_tokens_details?.cached_tokens ??
    rawUsage.prompt_cache_hit_tokens ??
    0;
  const cacheMissTokens = rawUsage.prompt_cache_miss_tokens ?? 0;
  // OpenAI's prompt_tokens includes cached tokens. For compatible providers
  // without that total, reporting uses the cache buckets only if one is positive.
  const inputTokens =
    rawUsage.prompt_tokens ??
    (cachedTokens > 0 || cacheMissTokens > 0
      ? cachedTokens + cacheMissTokens
      : 0);
  const tokens = {
    inputTokens,
    outputTokens: rawUsage.completion_tokens ?? 0,
    cachedTokens,
    cacheMissTokens,
    cacheCreationTokens:
      rawUsage.prompt_tokens_details?.cache_write_tokens ?? 0,
    reasoningTokens: rawUsage.completion_tokens_details?.reasoning_tokens ?? 0,
  };
  return normalizeUsage(provider, responseTimeMs, {
    ...tokens,
    rawUsage,
    cost: computeStandardPrice(
      {
        ...tokens,
        // Pricing retains the raw bucket sum even when neither is positive.
        inputTokens: rawUsage.prompt_tokens ?? cachedTokens + cacheMissTokens,
      },
      config,
    ),
  });
}
