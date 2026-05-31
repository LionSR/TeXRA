/**
 * Anthropic usage accounting & pricing.
 *
 * Pure functions extracted from `ModelHandlerAnthropic` so token accounting and
 * cache-aware price computation can be reasoned about and unit-tested without a
 * live handler instance. The handler keeps thin `computePrice` / `normalizeUsage`
 * overrides that delegate here with the model's pricing config.
 */

import type { AnthropicUsage } from '@agent/core/usage/ResponseUsage';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { calculateTokenPrice } from '@agent/utils/priceUtils';

import {
  CACHE_CREATION_COST_MULTIPLIER_5M,
  CACHE_CREATION_COST_MULTIPLIER_1H,
} from './anthropicContextManagement';
import { normalizeUsage } from '../support/UsageNormalizer';
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages';

/** Pricing inputs the handler supplies from its `config`/`capabilities`. */
export interface AnthropicPricingConfig {
  inputPrice: number;
  outputPrice: number;
  supportsPromptCaching: boolean;
  cacheDiscountFactor: number;
}

interface AnthropicUsageTokenTotals {
  baseInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
}

/**
 * Gets Anthropic input/output/cache token totals.
 * Uses per-iteration usage when available so compaction requests are fully billed.
 */
export function getAnthropicUsageTokenTotals(
  responseUsage: AnthropicUsage,
): AnthropicUsageTokenTotals {
  const usageWithIterations = responseUsage as AnthropicUsage & {
    iterations?: BetaUsage['iterations'];
  };
  const iterations = usageWithIterations.iterations;
  if (Array.isArray(iterations) && iterations.length > 0) {
    let baseInputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let cacheCreation5mTokens = 0;
    let cacheCreation1hTokens = 0;

    for (const iteration of iterations) {
      baseInputTokens += iteration.input_tokens;
      outputTokens += iteration.output_tokens;
      cacheReadTokens += iteration.cache_read_input_tokens;
      cacheCreationTokens += iteration.cache_creation_input_tokens;
      cacheCreation5mTokens +=
        iteration.cache_creation?.ephemeral_5m_input_tokens ?? 0;
      cacheCreation1hTokens +=
        iteration.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    }

    return {
      baseInputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cacheCreation5mTokens,
      cacheCreation1hTokens,
    };
  }

  return {
    baseInputTokens: responseUsage.input_tokens ?? 0,
    outputTokens: responseUsage.output_tokens ?? 0,
    cacheReadTokens: responseUsage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: responseUsage.cache_creation_input_tokens ?? 0,
    cacheCreation5mTokens:
      responseUsage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    cacheCreation1hTokens:
      responseUsage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  };
}

/** Calculates API usage cost based on input/output tokens and cache usage if supported. */
export function computeAnthropicPrice(
  responseUsage: AnthropicUsage,
  config: AnthropicPricingConfig,
): number {
  if (!responseUsage) {
    return 0;
  }

  // Note: Anthropic doesn't provide tool_use_tokens in their API response
  const usageTotals = getAnthropicUsageTokenTotals(responseUsage);

  // Standard pricing applies across the full context window (no long-context premium).
  const inputPrice = config.inputPrice;
  const outputPrice = config.outputPrice;

  let basePrice = calculateTokenPrice(
    usageTotals.baseInputTokens,
    usageTotals.outputTokens,
    inputPrice,
    outputPrice,
  );

  if (config.supportsPromptCaching) {
    if (usageTotals.cacheCreationTokens > 0) {
      const pricedBreakdownTokens =
        usageTotals.cacheCreation5mTokens + usageTotals.cacheCreation1hTokens;

      if (pricedBreakdownTokens > 0) {
        basePrice +=
          (usageTotals.cacheCreation5mTokens *
            inputPrice *
            CACHE_CREATION_COST_MULTIPLIER_5M) /
          1e6;
        basePrice +=
          (usageTotals.cacheCreation1hTokens *
            inputPrice *
            CACHE_CREATION_COST_MULTIPLIER_1H) /
          1e6;

        const unclassifiedCacheCreationTokens = Math.max(
          usageTotals.cacheCreationTokens - pricedBreakdownTokens,
          0,
        );
        basePrice +=
          (unclassifiedCacheCreationTokens *
            inputPrice *
            CACHE_CREATION_COST_MULTIPLIER_5M) /
          1e6;
      } else {
        basePrice +=
          (usageTotals.cacheCreationTokens *
            inputPrice *
            CACHE_CREATION_COST_MULTIPLIER_5M) /
          1e6;
      }
    }
    if (usageTotals.cacheReadTokens > 0) {
      basePrice +=
        (usageTotals.cacheReadTokens *
          inputPrice *
          config.cacheDiscountFactor) /
        1e6;
    }
  }

  return basePrice;
}

/** Normalizes Anthropic usage data into a unified format. */
export function normalizeAnthropicUsage(
  rawUsage: AnthropicUsage,
  responseTimeMs: number,
  config: AnthropicPricingConfig,
): NormalizedUsage {
  return normalizeUsage(
    {
      provider: 'anthropic',
      computePrice: (usage) => computeAnthropicPrice(usage, config),
      extract: (usage) => {
        const usageTotals = getAnthropicUsageTokenTotals(usage);
        // Anthropic bills cache-read and cache-creation tokens separately, so
        // total input is base + read + creation (matches percentageCached).
        const totalInput =
          usageTotals.baseInputTokens +
          usageTotals.cacheReadTokens +
          usageTotals.cacheCreationTokens;

        return {
          inputTokens: totalInput,
          outputTokens: usageTotals.outputTokens,
          cachedTokens: usageTotals.cacheReadTokens,
          cacheCreationTokens: usageTotals.cacheCreationTokens,
          cachePercentageBasis:
            usageTotals.cacheReadTokens + usageTotals.cacheCreationTokens,
          // SDK 0.100.0 reports the thinking-token breakdown of output_tokens,
          // so Anthropic surfaces reasoning tokens like OpenAI/Google/xAI. This
          // is a subset of outputTokens (already billed), not an extra charge.
          reasoningTokens: usage.output_tokens_details?.thinking_tokens ?? 0,
          serverToolRequests:
            (usage.server_tool_use?.web_search_requests ?? 0) +
            (usage.server_tool_use?.web_fetch_requests ?? 0),
        };
      },
    },
    rawUsage,
    responseTimeMs,
  );
}
