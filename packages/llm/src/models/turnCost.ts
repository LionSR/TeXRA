/**
 * What one completed turn cost, in USD, from the usage evidence its protocol
 * reported and the catalog's rates. The billing rules are wire facts: which
 * token classes a provider bills apart, and which receipt carries its own
 * settled cost.
 */
import { requestRates, type ModelConfig } from 'llm-zoo';

import type { TurnResult } from '../turn.js';

type TurnUsage = NonNullable<TurnResult['usage']>;

/** The per-million rates one turn bills at, and its cache-read rebate. */
interface TurnRates {
  readonly inputPrice: number;
  readonly outputPrice: number;
  readonly cacheDiscountFactor: number;
}

/** Prices are per million tokens. */
const perMillion = (tokens: number, price: number): number =>
  (tokens * price) / 1e6;

/**
 * Anthropic bills cache reads and writes as separate token classes on top
 * of the uncached input: reads at the model's cache discount (0.1x on most
 * models, 0.05x on Opus 5.5, 0.025x on Fable/Mythos 5.1), five-minute writes
 * at 1.25x and one-hour writes at 2x.
 */
function anthropicCost(
  usage: TurnUsage,
  provider: Extract<TurnUsage['providerUsage'], { kind: 'anthropic' }>,
  rates: TurnRates,
): number {
  const { inputPrice, outputPrice, cacheDiscountFactor } = rates;
  const uncached = provider.uncachedInputTokens ?? usage.inputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? 0;
  const write5m =
    provider.cacheCreation5mTokens ??
    (provider.cacheCreation1hTokens === null
      ? (provider.cacheCreationTokens ?? 0)
      : 0);
  const write1h = provider.cacheCreation1hTokens ?? 0;
  // Tokens the API left unattributed to a TTL bucket still bill; charge them
  // at the five-minute rate rather than dropping them from the turn.
  const unclassified = Math.max(
    0,
    (provider.cacheCreationTokens ?? 0) - write5m - write1h,
  );
  return (
    perMillion(uncached, inputPrice) +
    perMillion(cached, inputPrice * cacheDiscountFactor) +
    perMillion(write5m + unclassified, inputPrice * 1.25) +
    perMillion(write1h, inputPrice * 2) +
    perMillion(usage.outputTokens ?? 0, outputPrice)
  );
}

/**
 * Inclusive-cache cost: cached prompt tokens are a subset of the reported
 * input, billed at the input rate and rebated down to the model's cache
 * discount; reasoning tokens bill at the output rate on top of the output
 * count only where the provider reports them separately.
 */
function standardCost(
  usage: TurnUsage,
  rates: TurnRates,
  reasoningBilledSeparately: boolean,
): number {
  const { inputPrice, outputPrice, cacheDiscountFactor } = rates;
  const cached = usage.cachedInputTokens ?? 0;
  const reasoning = reasoningBilledSeparately
    ? (usage.reasoningTokens ?? 0)
    : 0;
  return (
    perMillion(usage.inputTokens ?? 0, inputPrice) +
    perMillion(usage.outputTokens ?? 0, outputPrice) +
    perMillion(reasoning, outputPrice) -
    perMillion(cached, inputPrice * (1 - cacheDiscountFactor))
  );
}

/**
 * The cost of one turn, never negative. A plan route (ChatGPT/Codex, Grok,
 * the GLM coding plan, Kimi Code) is covered by the subscription, so every
 * rate is zero and a receipt the provider settled bills an API key this turn
 * did not use. An API-key route bills the catalog's rates on its service
 * tier; a model with a long-context tier bills the whole request at it once
 * the prompt, cached tokens included, is above it (llm-zoo's
 * `requestRates`). A credit-backed OpenRouter receipt and an xAI receipt
 * carry their own settled cost, which wins over the computed one.
 */
export function turnCost(
  model: ModelConfig,
  usage: TurnUsage,
  billing: { readonly plan: boolean; readonly tier?: 'fast' },
): number {
  const { plan } = billing;
  const inputTokens = usage.inputTokens ?? 0;
  const rates: TurnRates = plan
    ? { inputPrice: 0, outputPrice: 0, cacheDiscountFactor: 1 }
    : requestRates(model, inputTokens, { tier: billing.tier });
  const provider = usage.providerUsage;
  let cost: number;
  switch (provider?.kind) {
    case 'anthropic':
      cost = anthropicCost(usage, provider, rates);
      break;
    case 'openrouter':
      // BYOK splits billing across accounts, so the settled figure is not
      // what this key paid: keep the full-inference estimate. A credit-backed
      // request bills the reported cost, including a reported zero.
      cost =
        !plan && provider.isByok !== true && provider.cost != null
          ? provider.cost
          : standardCost(usage, rates, false);
      break;
    case 'google':
      cost = standardCost(usage, rates, false);
      break;
    case 'xai':
      cost =
        !plan && provider.costInUsdTicks !== null
          ? provider.costInUsdTicks / 1e10
          : standardCost(usage, rates, true);
      break;
    case undefined:
      // Reasoning is part of the reported output everywhere but where a
      // receipt's total counts it beside the output (xAI Responses without
      // its cost field); there it bills on top.
      cost = standardCost(
        usage,
        rates,
        usage.reasoningTokens !== null &&
          usage.reasoningTokens > 0 &&
          usage.totalTokens ===
            inputTokens + (usage.outputTokens ?? 0) + usage.reasoningTokens,
      );
      break;
  }
  return Math.max(0, cost);
}
