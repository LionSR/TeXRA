/**
 * List-price equivalent cost for the subscription-backed usage entries of
 * released (0.40) clients.
 *
 * A 0.40 client prices a subscription round (ChatGPT/Codex, Kimi Code, Grok,
 * the GLM coding plan) at zeroed rates, so its entry arrives with `cost: 0`
 * even though llm-zoo still carries the model's API list price. This module
 * recovers that price, so `subscription_usage_logs.cost` answers "what would
 * this usage have cost at list price". Current clients send the list price
 * themselves (`log-usage-v2`).
 *
 * The 0.40 client reports `inputTokens` as cache-MISS tokens, with cached
 * tokens separate (its `UsageMonitor.logToBackend`), so the cost is
 *   miss·in + cached·in·discount + (output + separate reasoning)·out.
 * Reasoning tokens are already inside the output count for every provider
 * but xAI, whose receipts count them beside it; only there are they added.
 */

import {
  MODEL_CONFIGS,
  ModelProvider,
  requestRates,
  type ModelConfig,
} from 'llm-zoo';
import {
  subscriptionSourceForUsage,
  type UsageLogEntry,
} from './usageValidation.ts';

/**
 * Catalog entries keyed by API model id, with the short name as the
 * fallback key, for the `model` a 0.40 client sends. This function's
 * llm-zoo pin (2.0) covers every id the 0.40 clients' llm-zoo 1.x priced. A
 * fast service tier is a rate table inside the entry, so the entry's own
 * rates are the standard tier.
 */
const [configById, configByShortName] = (() => {
  const byId = new Map<string, ModelConfig>();
  const byShort = new Map<string, ModelConfig>();
  for (const config of Object.values(MODEL_CONFIGS)) {
    if (!byId.has(config.id)) byId.set(config.id, config);
    if (!byShort.has(config.shortName)) byShort.set(config.shortName, config);
  }
  return [byId, byShort];
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
  const config =
    configById.get(entry.model) ?? configByShortName.get(entry.model);
  if (!config) return undefined;

  const cached = entry.cachedInputTokens ?? 0;
  const reasoning =
    config.provider === ModelProvider.XAI ? (entry.reasoningTokens ?? 0) : 0;
  // One entry is one model request, so its prompt is the cache-miss input
  // plus the cached tokens, and a long prompt bills the whole request at the
  // model's long-context tier, as the client's run history does.
  const price = requestRates(config, entry.inputTokens + cached);
  const cost =
    (entry.inputTokens * price.inputPrice +
      cached * price.inputPrice * price.cacheDiscountFactor +
      (entry.outputTokens + reasoning) * price.outputPrice) /
    1e6;
  // Client-side costs are rounded to 6 decimals before logging; match that.
  return Math.round(cost * 1e6) / 1e6;
}

/**
 * The cost to store for an entry. Subscription rounds arrive with cost 0 (the
 * client prices them through zeroed subscription overrides), so they store
 * the list-price equivalent instead; any client-supplied nonzero cost passes
 * through.
 */
export function storedCost(entry: UsageLogEntry): number {
  if (entry.cost > 0 || subscriptionSourceForUsage(entry) === undefined) {
    return entry.cost;
  }
  const equivalent = equivalentListCost(entry);
  if (equivalent === undefined) {
    console.warn(
      `[LOG_USAGE] No llm-zoo list price for subscription model "${entry.model}"; equivalent cost left 0`,
    );
  }
  return equivalent ?? 0;
}
