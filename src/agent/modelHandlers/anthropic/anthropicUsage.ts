/**
 * Anthropic usage accounting & pricing.
 *
 * Pure functions extracted from `ModelHandlerAnthropic` so token accounting and
 * cache-aware price computation can be reasoned about and unit-tested without a
 * live handler instance. The handler keeps thin `computePrice` / `normalizeUsage`
 * overrides that delegate here with the model's pricing config.
 */

import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { calculateTokenPrice } from '@agent/utils/priceUtils';

import { normalizeUsage } from '../support/UsageNormalizer';
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages';

// Cache creation cost multipliers relative to base input price, by TTL.
const CACHE_CREATION_COST_MULTIPLIER_5M = 1.25;
const CACHE_CREATION_COST_MULTIPLIER_1H = 2.0;

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
 * Uses per-iteration usage when available so compaction requests are fully billed,
 * otherwise falls back to the top-level usage as a single source.
 */
function getAnthropicUsageTokenTotals(
  responseUsage: BetaUsage,
): AnthropicUsageTokenTotals {
  const iterations = responseUsage.iterations;
  const sources =
    Array.isArray(iterations) && iterations.length > 0
      ? iterations
      : [responseUsage];

  const totals: AnthropicUsageTokenTotals = {
    baseInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
  };

  for (const source of sources) {
    totals.baseInputTokens += source.input_tokens ?? 0;
    totals.outputTokens += source.output_tokens ?? 0;
    totals.cacheReadTokens += source.cache_read_input_tokens ?? 0;
    totals.cacheCreationTokens += source.cache_creation_input_tokens ?? 0;
    totals.cacheCreation5mTokens +=
      source.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    totals.cacheCreation1hTokens +=
      source.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  }

  return totals;
}

/** Calculates API usage cost based on input/output tokens and cache usage if supported. */
export function computeAnthropicPrice(
  responseUsage: BetaUsage,
  config: AnthropicPricingConfig,
): number {
  // Note: Anthropic doesn't provide tool_use_tokens in their API response
  const usageTotals = getAnthropicUsageTokenTotals(responseUsage);

  // Standard pricing applies across the full context window (no long-context premium).
  const inputPrice = config.inputPrice;
  const outputPrice = config.outputPrice;

  // Cache-creation tokens bill at a fixed multiplier of the input price per
  // million tokens, by TTL bucket.
  const priceForCacheCreation = (tokens: number, multiplier: number): number =>
    (tokens * inputPrice * multiplier) / 1e6;

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
      // Tokens the API left unattributed to a TTL bucket bill at the 5m rate.
      const unclassifiedCacheCreationTokens = Math.max(
        usageTotals.cacheCreationTokens - pricedBreakdownTokens,
        0,
      );

      basePrice += priceForCacheCreation(
        usageTotals.cacheCreation5mTokens,
        CACHE_CREATION_COST_MULTIPLIER_5M,
      );
      basePrice += priceForCacheCreation(
        usageTotals.cacheCreation1hTokens,
        CACHE_CREATION_COST_MULTIPLIER_1H,
      );
      basePrice += priceForCacheCreation(
        unclassifiedCacheCreationTokens,
        CACHE_CREATION_COST_MULTIPLIER_5M,
      );
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
  rawUsage: BetaUsage,
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
