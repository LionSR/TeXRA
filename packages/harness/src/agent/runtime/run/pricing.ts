/**
 * The run's priced usage for one completed turn. The package prices the
 * turn's usage evidence; the price is a runtime fact stamped on the
 * `response` row beside the dispatch facts (D12), so a resumed run's cost is
 * the sum of its rows and nothing else. Each priced call is also reported
 * to the process usage log, which bills per call.
 */
import { Effect } from 'effect';
import { turnCost, type TurnResult } from '@texra-ai/llm';

import type { SettingsStores } from '@shared/config/settingsAccess';
import type { NormalizedUsage, RunId } from '@shared/schemas';
import type { UsageLog } from '@shared/usageLog';
import { roundTo } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';

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

/**
 * Who a call's usage is billed to, as the usage log's wire names them. Every
 * field is stated: a call that serves no run (a draft polish) says so.
 */
export interface UsageAttribution {
  readonly agentName: string;
  readonly runId: RunId | null;
}

/**
 * Report one priced call to the process usage log, which bills per call. It
 * writes no session row: a turn's usage is its `response` row and a
 * compaction's its `context.edit` row.
 */
export const reportUsage = (
  usageLog: UsageLog['Service'],
  bound: BoundModel,
  usage: NormalizedUsage | null,
  attribution: UsageAttribution,
  { config }: SettingsStores,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (usage === null) return;
    const cachedInputTokens = usage.cachedInputTokens ?? 0;
    yield* Effect.try({
      try: () =>
        usageLog.log(
          {
            model: bound.config.id,
            provider: usage.provider,
            agentName: attribution.agentName,
            // Billing needs a real number, so a provider that reported no
            // cache-miss count is billed the derived estimate (input minus
            // cache-read). Display never guesses.
            inputTokens:
              usage.cacheMissInputTokens ??
              Math.max(0, usage.inputTokens - cachedInputTokens),
            outputTokens: usage.outputTokens,
            cost: roundTo(usage.cost, 6),
            responseTimeMs: Math.round(usage.responseTimeMs ?? 0),
            cachedInputTokens,
            reasoningTokens: usage.reasoningTokens ?? 0,
            usageRoute: usage.usageRoute ?? 'api-key',
            // The usage-log edge function's wire key, which stores the run id
            // in its `stream_id` column; a server-side rename, not ours.
            ...(attribution.runId === null
              ? {}
              : { streamId: attribution.runId }),
          },
          config,
        ),
      catch: ensureError,
    }).pipe(
      // Best-effort billing edge: a failed log never fails the call.
      Effect.catch((error) =>
        Effect.logWarning('Backend usage logging failed').pipe(
          Effect.annotateLogs({ error }),
        ),
      ),
    );
  });
