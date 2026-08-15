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
function tokenCounts(usage: InteractionsUsage | null): GoogleTokenCounts {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  }

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
    outputTokens: directOutput > 0 ? directOutput : derivedOutput,
    reasoningTokens,
  };
}

/** Compute Google cost from Interactions token totals. */
export function computeGoogleInteractionsPrice(
  usage: InteractionsUsage | null,
  config: StandardPricingConfig,
): number {
  const { inputTokens, outputTokens } = tokenCounts(usage);
  return computeStandardPrice(
    {
      inputTokens,
      outputTokens,
      cachedTokens: usage?.total_cached_tokens ?? 0,
    },
    config,
  );
}

/** Normalize Google Interactions usage into TeXRA's provider-neutral shape. */
export function normalizeGoogleInteractionsUsage(
  usage: InteractionsUsage | null,
  responseTimeMs: number,
  config: StandardPricingConfig,
): NormalizedUsage {
  return normalizeUsage(
    {
      provider: 'google',
      computePrice: (value) => computeGoogleInteractionsPrice(value, config),
      extract: (value) => {
        const { inputTokens, outputTokens, reasoningTokens } =
          tokenCounts(value);
        return {
          inputTokens,
          outputTokens,
          cachedTokens: value.total_cached_tokens ?? 0,
          reasoningTokens,
          toolUsePromptTokens: value.total_tool_use_tokens ?? 0,
        };
      },
    },
    usage,
    responseTimeMs,
  );
}
