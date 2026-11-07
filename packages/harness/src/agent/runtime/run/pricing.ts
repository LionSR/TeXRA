/**
 * The run's priced usage for one completed turn. The package prices the
 * turn's usage evidence; the price is a runtime fact stamped on the
 * `response` row beside the dispatch facts, so a resumed run's cost is
 * the sum of its rows and nothing else. Each call is also reported to the
 * process usage log, at its list price.
 */
import { Effect } from 'effect';
import { listCost, turnCost, type TurnResult } from '@texra-ai/llm';

import type { BoundModel } from '@agent/runtime/modelAccess/ModelAccess';
import type { NormalizedUsage, RunId } from '@shared/schemas';
import type { UsageLog } from '@shared/usageLog';
import type { SettingsStores } from '@shared/config/settings';
import { environment } from '@utils/system/nodeWorkspace';

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
  const usageRoute = bound.billing;
  const inputTokens = usage.inputTokens ?? 0;
  const {
    cachedInputTokens: cached,
    cacheWriteTokens,
    reasoningTokens,
    toolUsePromptTokens,
  } = usage;
  return {
    inputTokens,
    outputTokens: usage.outputTokens ?? 0,
    cost: turnCost(bound.config, usage, {
      plan: usageRoute !== 'api-key',
      tier: bound.serviceTier ?? undefined,
    }),
    responseTimeMs,
    provider: bound.origin.protocol,
    usageRoute,
    ...(bound.plan !== undefined ? { usagePlan: bound.plan } : {}),
    ...(cached !== null ? { cachedInputTokens: cached } : {}),
    ...(cached !== null && inputTokens >= cached
      ? { cacheMissInputTokens: inputTokens - cached }
      : {}),
    ...(cacheWriteTokens !== null ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== null ? { reasoningTokens } : {}),
    ...(toolUsePromptTokens !== null ? { toolUsePromptTokens } : {}),
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
 * Report one call's usage to the process usage log, under the catalog entry
 * and at its list price whatever the route billed, so a plan's call reads
 * what it would have cost on an API key. It writes no session row: a turn's
 * usage is its `response` row and a compaction's its `context.edit` row.
 * The log cannot fail: its sender owns delivery (queued, batched, retried)
 * and says so when it gives up.
 */
export const reportUsage = Effect.fn('pricing.reportUsage')(function* (
  usageLog: UsageLog['Service'],
  bound: BoundModel,
  usage: TurnResult['usage'],
  responseTimeMs: number,
  attribution: UsageAttribution,
  { config }: SettingsStores,
): Effect.fn.Return<void> {
  if (usage === null) return;
  const env = yield* environment;
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  yield* usageLog.log(
    {
      model: bound.catalogEntry.id,
      provider: bound.origin.protocol,
      agentName: attribution.agentName,
      // The cache-miss input: the reported input less its cache reads.
      inputTokens: Math.max(0, (usage.inputTokens ?? 0) - cachedInputTokens),
      outputTokens: usage.outputTokens ?? 0,
      listCost: Number(
        listCost(
          bound.catalogEntry,
          usage,
          bound.serviceTier ?? undefined,
        ).toFixed(6),
      ),
      responseTimeMs: Math.round(responseTimeMs),
      cachedInputTokens,
      reasoningTokens: usage.reasoningTokens ?? 0,
      usageRoute: bound.billing,
      // The usage-log edge function's wire key, which stores the run id
      // in its `stream_id` column; a server-side rename, not ours.
      ...(attribution.runId === null ? {} : { streamId: attribution.runId }),
    },
    config,
    env,
  );
});
