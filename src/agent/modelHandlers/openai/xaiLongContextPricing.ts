/**
 * xAI pricing data the llm-zoo catalog does not carry, keyed by catalog
 * `fullName`.
 *
 * Source: the models catalog embedded in docs.x.ai (per-model
 * `longContextThreshold`, the `*LongContext` prompt/completion rates, and the
 * cached-token rates), verified 2026-08-14. llm-zoo carries only the
 * short-context rates and has no tier field (still true at 1.28.0), and its
 * xAI entries inherit the default `cacheDiscountFactor` of 1, so both the
 * tier tuple and the cache factor live here until the catalog exposes them —
 * migrate this table to it then (the gate #10073 was filed under). Rates are
 * USD per 1M tokens.
 *
 * xAI's cached long-context rate equals the tier's input rate scaled by the
 * model's cache discount factor for every listed model (the documented cached
 * rate doubles together with the input rate), so the factor applies on both
 * sides of the threshold and the rebate in `computeStandardPrice` follows the
 * tier switch on its own.
 *
 * The model set is cross-checked against the llm-zoo catalog: a live xAI
 * model whose context window clears the lowest documented threshold but which
 * has no row here trips {@link xaiLongContextTierGap} so it surfaces loudly
 * instead of silently billing flat.
 */

// Third-party imports
import { ModelProvider, type ModelConfig } from 'llm-zoo';

// Local imports
import type { LongContextPricingTier } from '@agent/modelHandlers/support/priceUtils';

/** Documented rates llm-zoo lacks for one xAI model. */
interface XaiDocumentedPricing {
  tier: LongContextPricingTier;
  /** Cached tokens bill at this fraction of the (tier-following) input rate. */
  cacheDiscountFactor: number;
}

const XAI_DOCUMENTED_PRICING: Readonly<Record<string, XaiDocumentedPricing>> = {
  'grok-4.3': {
    tier: { thresholdTokens: 200_000, inputPrice: 2.5, outputPrice: 5 },
    cacheDiscountFactor: 0.16,
  },
  'grok-4.5': {
    tier: { thresholdTokens: 200_000, inputPrice: 4, outputPrice: 12 },
    cacheDiscountFactor: 0.15,
  },
  'grok-4.6': {
    tier: { thresholdTokens: 200_000, inputPrice: 4, outputPrice: 12 },
    cacheDiscountFactor: 0.25,
  },
};

/** Lowest documented long-context threshold; the tripwire reference below. */
const LOWEST_DOCUMENTED_THRESHOLD_TOKENS = Math.min(
  ...Object.values(XAI_DOCUMENTED_PRICING).map(
    (pricing) => pricing.tier.thresholdTokens,
  ),
);

/**
 * The documented long-context tier for an xAI model id, or undefined when xAI
 * publishes none (including OpenRouter-qualified ids, which bill on
 * OpenRouter's rates instead).
 */
export function xaiLongContextTier(
  fullName: string,
): LongContextPricingTier | undefined {
  const tier = XAI_DOCUMENTED_PRICING[fullName]?.tier;
  return tier ? { ...tier } : undefined;
}

/**
 * The documented cached-token rate as a fraction of the model's input rate,
 * or undefined when unlisted. Prefer this over the catalog's
 * `capabilities.cacheDiscountFactor`, which is the no-discount default for
 * every xAI entry and would zero the cache rebate.
 */
export function xaiCacheDiscountFactor(fullName: string): number | undefined {
  return XAI_DOCUMENTED_PRICING[fullName]?.cacheDiscountFactor;
}

/**
 * True when a catalog entry looks like it should have a documented tier but
 * has none: a live xAI model (not deprecated or retired) whose context window
 * exceeds the lowest documented threshold, with no row above. This is the
 * drift tripwire for the hand-maintained table — a new tiered xAI model
 * warns through the handler instead of silently billing flat rates.
 */
export function xaiLongContextTierGap(
  model: Pick<
    ModelConfig,
    'provider' | 'fullName' | 'contextWindow' | 'deprecated' | 'retired'
  >,
): boolean {
  return (
    model.provider === ModelProvider.XAI &&
    model.deprecated !== true &&
    model.retired !== true &&
    model.contextWindow > LOWEST_DOCUMENTED_THRESHOLD_TOKENS &&
    XAI_DOCUMENTED_PRICING[model.fullName] === undefined
  );
}
