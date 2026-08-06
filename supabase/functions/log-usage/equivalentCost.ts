/**
 * List-price equivalent cost for subscription-backed usage entries.
 *
 * Subscription rounds (ChatGPT/Codex, Kimi Code, Grok) reach the client's
 * pricing layer with zeroed rates (`zeroCostAccessOverrides` in
 * `src/model/subscriptionAccessOverrides.ts`), so their entries arrive here
 * with `cost: 0` even though llm-zoo still carries the models' API list
 * prices. This module recovers the notional cost server-side so
 * `subscription_usage_logs.cost` answers "what would this usage have cost at
 * list price" for every client version, old or new.
 *
 * Formula parity: mirrors the client's `computeStandardPrice`
 * (`src/agent/utils/priceUtils.ts`) on the wire fields. The client reports
 * `inputTokens` as cache-MISS tokens (`UsageMonitor.logToBackend` sends
 * `usage.cacheMissInputTokens`) with cached tokens separate, so
 *   miss·in + cached·in·discount + (output + reasoning)·out
 * is algebraically the client's inclusive-cache formula
 *   input·in − cached·in·(1−discount) + output·out + reasoning·out.
 */

import { MODEL_CONFIGS } from 'llm-zoo';
import type { UsageLogEntry } from './usageValidation.ts';

interface ListPrice {
  inputPrice: number;
  outputPrice: number;
  cacheDiscountFactor: number;
}

/**
 * Standard-tier list prices keyed by API model name. Fast-tier registry
 * entries (`serviceTier: 'fast'`) carry premium rates for the same model id
 * and are skipped; among remaining duplicates (e.g. gpt-5.6-sol standard vs
 * pro mode, which bill identically) the first registry entry wins.
 */
const [priceByFullName, priceByShortName] = (() => {
  const byFull = new Map<string, ListPrice>();
  const byShort = new Map<string, ListPrice>();
  for (const config of Object.values(MODEL_CONFIGS)) {
    if (config.serviceTier === 'fast') continue;
    const price: ListPrice = {
      inputPrice: config.inputPrice,
      outputPrice: config.outputPrice,
      cacheDiscountFactor: config.capabilities?.cacheDiscountFactor ?? 1,
    };
    if (!byFull.has(config.fullName)) byFull.set(config.fullName, price);
    if (!byShort.has(config.shortName)) byShort.set(config.shortName, price);
  }
  return [byFull, byShort];
})();

/**
 * Compute the list-price equivalent cost (USD) for a usage entry, or
 * undefined when the model has no llm-zoo entry. A registry price of 0
 * (e.g. Kimi-Code-exclusive models) yields 0 — that IS the list price,
 * not a lookup failure.
 */
export function equivalentListCost(
  entry: Pick<
    UsageLogEntry,
    | 'model'
    | 'inputTokens'
    | 'outputTokens'
    | 'cachedInputTokens'
    | 'reasoningTokens'
  >,
): number | undefined {
  const price =
    priceByFullName.get(entry.model) ?? priceByShortName.get(entry.model);
  if (!price) return undefined;

  const cached = entry.cachedInputTokens ?? 0;
  const reasoning = entry.reasoningTokens ?? 0;
  const cost =
    (entry.inputTokens * price.inputPrice +
      cached * price.inputPrice * price.cacheDiscountFactor +
      (entry.outputTokens + reasoning) * price.outputPrice) /
    1e6;
  // Client-side costs are rounded to 6 decimals before logging; match that.
  return Math.round(cost * 1e6) / 1e6;
}
