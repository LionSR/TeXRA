/**
 * The run's priced usage for one completed turn. The package prices the
 * turn's usage evidence; the price is a runtime fact stamped on the
 * `response` row beside the dispatch facts (D12), so a resumed run's cost is
 * the sum of its rows and nothing else.
 */
import { turnCost, type TurnResult } from '@texra-ai/llm';

import type { NormalizedUsage } from '@shared/schemas';

import type { BoundModel } from './modelBinding';

/**
 * The priced usage of one turn, or `null` when the provider reported none.
 * A plan route bills nothing: the subscription already paid for the call.
 */
export function priceTurnUsage(
  bound: BoundModel,
  usage: TurnResult['usage'],
  responseTimeMs: number,
): NormalizedUsage | null {
  if (usage === null) return null;
  const provider = usage.providerUsage;
  const inputTokens = usage.inputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? undefined;
  const reasoning = usage.reasoningTokens ?? undefined;
  let cacheCreationTokens: number | undefined;
  let toolUsePromptTokens: number | undefined;
  switch (provider?.kind) {
    case 'anthropic':
      cacheCreationTokens = provider.cacheCreationTokens ?? undefined;
      break;
    case 'openrouter':
      cacheCreationTokens =
        provider.inputDetails?.cacheWriteTokens ?? undefined;
      break;
    case 'google':
      toolUsePromptTokens = provider.toolUsePromptTokens ?? undefined;
      break;
    case 'xai':
    case undefined:
      break;
  }
  return {
    inputTokens,
    outputTokens: usage.outputTokens ?? 0,
    cost: turnCost(bound.config, usage, {
      plan: bound.usageRoute !== 'api-key',
      tier: bound.serviceTier,
    }),
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
