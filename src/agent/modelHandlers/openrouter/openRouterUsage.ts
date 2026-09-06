/**
 * OpenRouter (native SDK) usage accounting & pricing.
 *
 * Pure functions extracted from `ModelHandlerOpenRouterNative` so token
 * accounting and cache-aware price computation can be reasoned about and
 * unit-tested without a live handler instance. The handler keeps a thin
 * `normalizeUsage` override that delegates here with the model's pricing
 * config and provider id.
 */

import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import {
  computeStandardPrice,
  type StandardPricingConfig,
} from '@agent/modelHandlers/support/priceUtils';

import { normalizeUsage } from '../support/UsageNormalizer';
import type { ChatUsage } from '@openrouter/sdk/models';

/** Normalizes OpenRouter usage data into a unified format. */
export function normalizeOpenRouterUsage(
  rawUsage: ChatUsage | null,
  responseTimeMs: number,
  provider: NormalizedUsage['provider'],
  config: StandardPricingConfig,
): NormalizedUsage {
  if (!rawUsage) return normalizeUsage(provider, responseTimeMs, null);

  const tokens = {
    inputTokens: rawUsage.promptTokens ?? 0,
    outputTokens: rawUsage.completionTokens ?? 0,
    cachedTokens: rawUsage.promptTokensDetails?.cachedTokens ?? 0,
    reasoningTokens: rawUsage.completionTokensDetails?.reasoningTokens ?? 0,
  };
  // BYOK splits billing across accounts; retain the full-inference estimate.
  // Credit-backed requests use the provider's billed cost, including zero.
  const cost =
    rawUsage.isByok !== true && rawUsage.cost != null
      ? rawUsage.cost
      : computeStandardPrice(tokens, config);
  return normalizeUsage(provider, responseTimeMs, {
    ...tokens,
    rawUsage,
    cost,
  });
}
