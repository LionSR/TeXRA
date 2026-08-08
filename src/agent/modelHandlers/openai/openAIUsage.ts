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
import {
  computeStandardPrice,
  type StandardPricingConfig,
} from '@agent/utils/priceUtils';

import { normalizeUsage } from '../support/UsageNormalizer';
import type { ResponseUsage } from 'openai/resources/responses/responses';

/**
 * Cached prompt tokens. OpenAI reports them under
 * `prompt_tokens_details.cached_tokens`; DeepSeek uses `prompt_cache_hit_tokens`.
 */
function getCachedTokens(usage: ExtendedCompletionUsage): number {
  return (
    usage.prompt_tokens_details?.cached_tokens ??
    usage.prompt_cache_hit_tokens ??
    0
  );
}

/** Computes cost based on token usage and model pricing. */
export function computeOpenAIPrice(
  responseUsage: ExtendedCompletionUsage | null,
  config: StandardPricingConfig,
): number {
  if (!responseUsage) return 0;

  const cachedTokens = getCachedTokens(responseUsage);
  const promptTokens =
    responseUsage.prompt_tokens ??
    cachedTokens + (responseUsage.prompt_cache_miss_tokens ?? 0);
  // Note: OpenAI doesn't provide tool_use_tokens in their API response

  return computeStandardPrice(
    {
      inputTokens: promptTokens,
      outputTokens: responseUsage.completion_tokens ?? 0,
      cachedTokens,
      reasoningTokens:
        responseUsage.completion_tokens_details?.reasoning_tokens ?? 0,
    },
    config,
  );
}

/**
 * Cost for the Responses API. Same inclusive-cache formula as
 * {@link computeOpenAIPrice}; only the token field names differ
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
  return normalizeUsage(
    {
      provider,
      computePrice,
      extract: (usage) => ({
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
        cacheCreationTokens:
          usage.input_tokens_details?.cache_write_tokens ?? 0,
        reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
      }),
    },
    rawUsage,
    responseTimeMs,
  );
}

/** Normalizes OpenAI usage data into a unified format. */
export function normalizeOpenAIUsage(
  rawUsage: ExtendedCompletionUsage | null,
  responseTimeMs: number,
  provider: NormalizedUsage['provider'],
  config: StandardPricingConfig,
): NormalizedUsage {
  return normalizeUsage(
    {
      provider,
      computePrice: (usage) => computeOpenAIPrice(usage, config),
      extract: (usage) => {
        const cachedTokens = getCachedTokens(usage);
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
          cacheCreationTokens:
            usage.prompt_tokens_details?.cache_write_tokens ?? 0,
          reasoningTokens:
            usage.completion_tokens_details?.reasoning_tokens ?? 0,
        };
      },
    },
    rawUsage,
    responseTimeMs,
  );
}
