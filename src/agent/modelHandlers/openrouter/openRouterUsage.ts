/**
 * OpenRouter (native SDK) usage accounting & pricing.
 *
 * Pure functions extracted from `ModelHandlerOpenRouterNative` so token
 * accounting and cache-aware price computation can be reasoned about and
 * unit-tested without a live handler instance. The handler keeps thin
 * `computePrice` / `normalizeUsage` overrides that delegate here with the
 * model's pricing config and provider id.
 */

import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import {
  computeStandardPrice,
  type StandardPricingConfig,
} from '@agent/modelHandlers/support/priceUtils';

import { normalizeUsage } from '../support/UsageNormalizer';
import type { ChatUsage } from '@openrouter/sdk/models';

/**
 * Prefer OpenRouter's billed cost for credit-backed requests. BYOK cost is
 * split between OpenRouter credits and the upstream provider account, so keep
 * the existing static full-inference estimate for that route.
 */
export function computeOpenRouterPrice(
  responseUsage: ChatUsage | null,
  config: StandardPricingConfig,
): number {
  if (!responseUsage) return 0;
  if (responseUsage.isByok !== true && responseUsage.cost != null) {
    return responseUsage.cost;
  }

  return computeStandardPrice(
    {
      inputTokens: responseUsage.promptTokens ?? 0,
      outputTokens: responseUsage.completionTokens ?? 0,
      cachedTokens: responseUsage.promptTokensDetails?.cachedTokens ?? 0,
      reasoningTokens:
        responseUsage.completionTokensDetails?.reasoningTokens ?? 0,
    },
    config,
  );
}

/** Normalizes OpenRouter usage data into a unified format. */
export function normalizeOpenRouterUsage(
  rawUsage: ChatUsage | null,
  responseTimeMs: number,
  provider: NormalizedUsage['provider'],
  config: StandardPricingConfig,
): NormalizedUsage {
  return normalizeUsage(
    {
      provider,
      computePrice: (usage) => computeOpenRouterPrice(usage, config),
      extract: (usage) => ({
        inputTokens: usage.promptTokens ?? 0,
        outputTokens: usage.completionTokens ?? 0,
        cachedTokens: usage.promptTokensDetails?.cachedTokens ?? 0,
        reasoningTokens: usage.completionTokensDetails?.reasoningTokens ?? 0,
      }),
    },
    rawUsage,
    responseTimeMs,
  );
}
