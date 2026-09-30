/**
 * The run's price for one completed turn. The package observes token counts
 * and provider-specific extras; the price is a runtime fact stamped on the
 * `response` row beside the dispatch facts (D12), so a resumed run's cost is
 * the sum of its rows and nothing else.
 */
import { requestRates } from 'llm-zoo';

import type { NormalizedUsage } from '@shared/schemas';

import type { TurnResult } from '@texra-ai/llm/turn';
import type { BoundModel } from './modelBinding';

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
 * The rates for one turn. A plan route (ChatGPT/Codex, Grok, the GLM coding
 * plan, Kimi Code) is covered by the subscription, so every rate is zero and
 * the run records tokens without spend; an API-key route bills the catalog's
 * rates for the bound model on its service tier. A model with a documented
 * long-context tier (OpenAI above 272K, xAI and Gemini Pro above 200K) bills the whole request
 * at the tier once the prompt, cached tokens included, is above it; llm-zoo's
 * `requestRates` owns that rule.
 */
function turnRates(
  bound: BoundModel,
  plan: boolean,
  promptTokens: number,
): TurnRates {
  if (plan) return { inputPrice: 0, outputPrice: 0, cacheDiscountFactor: 1 };
  return requestRates(bound.config, promptTokens, { tier: bound.serviceTier });
}

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
  const inputTokens = usage.inputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? 0;
  const reasoning = reasoningBilledSeparately
    ? (usage.reasoningTokens ?? 0)
    : 0;
  return (
    perMillion(inputTokens, inputPrice) +
    perMillion(usage.outputTokens ?? 0, outputPrice) +
    perMillion(reasoning, outputPrice) -
    perMillion(cached, inputPrice * (1 - cacheDiscountFactor))
  );
}

/**
 * The priced usage of one turn, or `null` when the provider reported none.
 * A credit-backed OpenRouter receipt carries its own settled cost, which wins
 * over a price computed from the registry's per-provider rates. A plan route
 * bills neither: the subscription already paid for the call, and a receipt the
 * provider settled bills an API key that this turn did not use.
 */
export function priceTurnUsage(
  bound: BoundModel,
  usage: TurnResult['usage'],
  responseTimeMs: number,
): NormalizedUsage | null {
  if (usage === null) return null;
  const provider = usage.providerUsage;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? undefined;
  const reasoning = usage.reasoningTokens ?? undefined;
  const plan = bound.usageRoute !== 'api-key';
  const rates = turnRates(bound, plan, inputTokens);
  let cost: number;
  let cacheCreationTokens: number | undefined;
  let toolUsePromptTokens: number | undefined;
  switch (provider?.kind) {
    case 'anthropic':
      cost = anthropicCost(usage, provider, rates);
      cacheCreationTokens = provider.cacheCreationTokens ?? undefined;
      break;
    case 'openrouter':
      // BYOK splits billing across accounts, so the settled figure is not
      // what this key paid: keep the full-inference estimate. A credit-backed
      // request bills the reported cost, including a reported zero.
      cost =
        !plan && provider.isByok !== true && provider.cost != null
          ? provider.cost
          : standardCost(usage, rates, false);
      cacheCreationTokens =
        provider.inputDetails?.cacheWriteTokens ?? undefined;
      break;
    case 'google':
      cost = standardCost(usage, rates, false);
      toolUsePromptTokens = provider.toolUsePromptTokens ?? undefined;
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
      // its cost field); there it bills on top. An editor (`vscode-lm`) turn
      // never reaches here: the editor model reports `usage: null`.
      cost = standardCost(
        usage,
        rates,
        usage.reasoningTokens !== null &&
          usage.reasoningTokens > 0 &&
          usage.totalTokens ===
            inputTokens + outputTokens + usage.reasoningTokens,
      );
      break;
  }
  return {
    inputTokens,
    outputTokens,
    cost: Math.max(0, cost),
    responseTimeMs,
    provider: bound.origin.protocol,
    usageRoute: bound.usageRoute,
    ...(bound.usagePlan !== undefined ? { usagePlan: bound.usagePlan } : {}),
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(cached !== undefined && inputTokens >= cached
      ? { cacheMissInputTokens: inputTokens - cached }
      : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(toolUsePromptTokens !== undefined ? { toolUsePromptTokens } : {}),
  };
}
