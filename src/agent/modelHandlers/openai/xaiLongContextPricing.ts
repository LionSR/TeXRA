/**
 * xAI long-context pricing tiers, keyed by llm-zoo `fullName`.
 *
 * Source: the models catalog embedded in docs.x.ai (per-model
 * `longContextThreshold` plus the `*LongContext` prompt/completion rates),
 * verified 2026-08-14. llm-zoo carries only the short-context rates and has
 * no tier field, so the tier tuple lives here until a catalog exposes one.
 * Rates are USD per 1M tokens. xAI's cached long-context rate equals the
 * tier's input rate scaled by the model's usual cache discount factor for
 * every listed model, so the tier carries only the input/output tuple; the
 * rebate in `computeStandardPrice` follows the tier switch on its own.
 */

import type { LongContextPricingTier } from '@agent/utils/priceUtils';

const XAI_LONG_CONTEXT_TIERS: Readonly<Record<string, LongContextPricingTier>> =
  {
    'grok-4.3': { thresholdTokens: 200_000, inputPrice: 2.5, outputPrice: 5 },
    'grok-4.5': { thresholdTokens: 200_000, inputPrice: 4, outputPrice: 12 },
    'grok-4.6': { thresholdTokens: 200_000, inputPrice: 4, outputPrice: 12 },
  };

/**
 * The documented long-context tier for an xAI model id, or undefined when xAI
 * publishes none (including OpenRouter-qualified ids, which bill on
 * OpenRouter's rates instead).
 */
export function xaiLongContextTier(
  fullName: string,
): LongContextPricingTier | undefined {
  const tier = XAI_LONG_CONTEXT_TIERS[fullName];
  return tier ? { ...tier } : undefined;
}
