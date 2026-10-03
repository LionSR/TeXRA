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
 * Formula parity: mirrors the client's `standardCost`
 * (`src/agent/runtime/run/pricing.ts`) on the wire fields. The client reports
 * `inputTokens` as cache-MISS tokens (`UsageMonitor.logToBackend` sends
 * `usage.cacheMissInputTokens`) with cached tokens separate, so
 *   miss·in + cached·in·discount + (output + separate reasoning)·out
 * is algebraically the client's inclusive-cache formula
 *   input·in − cached·in·(1−discount) + output·out + separate reasoning·out.
 * Reasoning tokens are already inside the output count for every provider
 * but xAI, whose receipts count them beside it (`responsesUsage` in
 * `packages/llm/src/openaiResponsesUsage.ts`); only there are they added.
 */

import {
  MODEL_CONFIGS,
  ModelProvider,
  requestRates,
  type ModelConfig,
} from 'llm-zoo';
import type { UsageLogEntry } from './usageValidation.ts';

/**
 * Catalog entries keyed by the provider's API model id, the `model` every
 * client version sends (llm-zoo 2.0 covers every id 1.x priced). A fast
 * service tier is a rate table inside the entry, so the entry's own rates
 * are the standard tier. A short name is the fallback key.
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
  // model's long-context tier, as the client's run ledger does.
  const price = requestRates(config, entry.inputTokens + cached);
  const cost =
    (entry.inputTokens * price.inputPrice +
      cached * price.inputPrice * price.cacheDiscountFactor +
      (entry.outputTokens + reasoning) * price.outputPrice) /
    1e6;
  // Client-side costs are rounded to 6 decimals before logging; match that.
  return Math.round(cost * 1e6) / 1e6;
}
