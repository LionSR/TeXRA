/** Google Interactions usage accounting and pricing. */

import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import {
  computeStandardPrice,
  type StandardPricingConfig,
} from '@agent/modelHandlers/support/priceUtils';

import { normalizeUsage } from '../support/UsageNormalizer';

import type { Interactions } from '@google/genai';

type InteractionsUsage = Interactions.Usage;

interface GoogleTokenCounts {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** Map Interactions totals onto TeXRA's unified token model. */
function tokenCounts(usage: InteractionsUsage): GoogleTokenCounts {
  const inputTokens =
    (usage.total_input_tokens ?? 0) + (usage.total_tool_use_tokens ?? 0);
  const reasoningTokens = usage.total_thought_tokens ?? 0;
  const directOutput = (usage.total_output_tokens ?? 0) + reasoningTokens;
  const derivedOutput = Math.max(
    0,
    (usage.total_tokens ?? inputTokens) - inputTokens,
  );

  return {
    inputTokens,
    // Not `Math.max`: `derivedOutput` is a fallback estimate, and
    // `total_tokens` can carry tokens beyond `inputTokens + directOutput`
    // (cached input), so preferring the larger value double-counts.
    outputTokens: directOutput > 0 ? directOutput : derivedOutput,
    reasoningTokens,
  };
}

/** Normalize Google Interactions usage into TeXRA's provider-neutral shape. */
export function normalizeGoogleInteractionsUsage(
  usage: InteractionsUsage | null,
  responseTimeMs: number,
  config: StandardPricingConfig,
): NormalizedUsage {
  if (!usage) return normalizeUsage('google', responseTimeMs, null);

  const { inputTokens, outputTokens, reasoningTokens } = tokenCounts(usage);
  const tokens = {
    inputTokens,
    outputTokens,
    cachedTokens: usage.total_cached_tokens ?? 0,
  };
  return normalizeUsage('google', responseTimeMs, {
    ...tokens,
    rawUsage: usage,
    reasoningTokens,
    toolUsePromptTokens: usage.total_tool_use_tokens ?? 0,
    // Output already includes thought tokens; do not add a reasoning surcharge.
    cost: computeStandardPrice(tokens, config),
  });
}
