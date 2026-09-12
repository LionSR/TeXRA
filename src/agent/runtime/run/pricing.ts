/**
 * The run's price for one completed turn. The package observes token counts
 * and provider-specific extras; the price is a runtime fact stamped on the
 * `response` row beside the dispatch facts (D12), so a resumed run's cost is
 * the sum of its rows and nothing else.
 */
import type { TurnResult } from '@llm/turn';
import type { NormalizedUsage } from '@shared/schemas';

import type { BoundModel } from './modelBinding';

type TurnUsage = NonNullable<TurnResult['usage']>;

/** Prices are per million tokens. */
const perMillion = (tokens: number, price: number): number =>
  (tokens * price) / 1e6;

/**
 * Anthropic bills cache reads and writes as separate token classes on top
 * of the uncached input: reads at a tenth of the input rate, five-minute
 * writes at 1.25x and one-hour writes at 2x.
 */
function anthropicCost(
  usage: TurnUsage,
  provider: Extract<TurnUsage['providerUsage'], { kind: 'anthropic' }>,
  inputPrice: number,
  outputPrice: number,
): number {
  const uncached = provider.uncachedInputTokens ?? usage.inputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? 0;
  const write5m =
    provider.cacheCreation5mTokens ??
    (provider.cacheCreation1hTokens === null
      ? (provider.cacheCreationTokens ?? 0)
      : 0);
  const write1h = provider.cacheCreation1hTokens ?? 0;
  return (
    perMillion(uncached, inputPrice) +
    perMillion(cached, inputPrice * 0.1) +
    perMillion(write5m, inputPrice * 1.25) +
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
  bound: BoundModel,
  reasoningBilledSeparately: boolean,
): number {
  const { inputPrice, outputPrice } = bound.config;
  const { cacheDiscountFactor } = bound.config.capabilities;
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
 * An OpenRouter receipt carries its own settled cost, which wins over a
 * price computed from the registry's per-provider rates.
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
  let cost: number;
  let cacheCreationTokens: number | undefined;
  let toolUsePromptTokens: number | undefined;
  switch (provider?.kind) {
    case 'anthropic':
      cost = anthropicCost(
        usage,
        provider,
        bound.config.inputPrice,
        bound.config.outputPrice,
      );
      cacheCreationTokens = provider.cacheCreationTokens ?? undefined;
      break;
    case 'openrouter':
      cost = provider.cost ?? standardCost(usage, bound, false);
      cacheCreationTokens =
        provider.inputDetails?.cacheWriteTokens ?? undefined;
      break;
    case 'google':
      cost = standardCost(usage, bound, false);
      toolUsePromptTokens = provider.toolUsePromptTokens ?? undefined;
      break;
    case 'xai':
      cost =
        provider.costInUsdTicks !== null
          ? provider.costInUsdTicks / 1e10
          : standardCost(usage, bound, true);
      break;
    case 'minimax':
    case undefined:
      cost = standardCost(usage, bound, bound.usageProvider === 'openai');
      break;
  }
  return {
    inputTokens,
    outputTokens,
    cost: Math.max(0, cost),
    responseTimeMs,
    provider: bound.usageProvider,
    usageRoute: bound.usageRoute,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(cached !== undefined && inputTokens >= cached
      ? { cacheMissInputTokens: inputTokens - cached }
      : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(toolUsePromptTokens !== undefined ? { toolUsePromptTokens } : {}),
  };
}
