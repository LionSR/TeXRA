import type { AgentTrace } from '@agent/trace';
import type { ConfigProvider } from '@platform/interfaces';
import type {
  AgentCategory,
  NormalizedUsage,
  RunId,
  RunUsageTotals,
  UsageRoute,
} from '@shared/schemas';
import type { UsageLog, UsageLogStats } from '@shared/usageLog';
import { roundTo } from '@utils/core';
import type { ModelConfig } from 'llm-zoo';

/**
 * Cache-miss tokens billed for this round. Backend billing always needs a
 * real number, so it falls back to the derived estimate (input minus
 * cache-read) when the provider is silent. Display never guesses: it shows
 * only what a provider reported.
 */
function billedRoundCacheMissTokens(
  reported: number | undefined,
  roundInputTokens: number,
  roundCacheReadTokens: number,
): number {
  return reported ?? Math.max(0, roundInputTokens - roundCacheReadTokens);
}

/**
 * Metadata for usage logging. Required because `agentCategory` is billed
 * with every round — a silent default would misreport usage runs from a
 * future caller that forgot to set it.
 */
interface UsageMonitorMetadata {
  /** Agent name for backend logging */
  agentName: string;
  /** Agent category: workflow or toolUse */
  agentCategory: AgentCategory;
}

/**
 * Minimal model info needed for usage logging: the name the backend bills
 * the round under.
 */
type UsageMonitorModelInfo = Pick<ModelConfig, 'fullName'>;

/**
 * Runtime dependencies for UsageMonitor — the individual run facts it reads,
 * never a whole run context:
 *
 * - logger: For error logging
 * - runId: The run whose usage this is (immutable)
 */
interface UsageMonitorContext {
  logger: AgentTrace;
  runId: RunId;
  /** The run's workspace configuration, which usage logging reads consent from. */
  config: ConfigProvider;
  usageLog: UsageLog['Service'];
}

/**
 * Reports each priced round to the usage log, which bills per round. It
 * writes no session row: the round's usage is its `model.message` response
 * row, and every display of it is a projection of that row.
 */
export class UsageMonitor {
  constructor(
    private readonly context: UsageMonitorContext,
    private readonly metadata: UsageMonitorMetadata,
  ) {}

  /**
   * Record one round's usage against `bound`, the run's binding that served
   * it. `totals` are the run's folded totals after the round; `latestUsage`
   * is the round's own priced usage. The loop passes the model it actually
   * ran, so a mid-run switch is billed against it without anyone mirroring
   * it back in.
   */
  recordUsage(
    totals: RunUsageTotals,
    latestUsage: NormalizedUsage | null,
    bound: { readonly config: UsageMonitorModelInfo },
  ): void {
    if (!latestUsage) return;
    const roundCacheReadTokens = latestUsage.cachedInputTokens ?? 0;
    this.logToBackend(
      totals.totalResponseTimeMs,
      {
        outputTokens: latestUsage.outputTokens,
        cachedInputTokens: roundCacheReadTokens,
        cacheMissInputTokens: billedRoundCacheMissTokens(
          latestUsage.cacheMissInputTokens,
          latestUsage.inputTokens,
          roundCacheReadTokens,
        ),
        reasoningTokens: latestUsage.reasoningTokens ?? 0,
        cost: latestUsage.cost,
        usageRoute: latestUsage.usageRoute ?? 'api-key',
      },
      latestUsage.provider,
      bound.config,
    );
  }

  /**
   * Log per-round usage to backend for analytics/billing.
   * Errors are caught and logged, never thrown.
   */
  private logToBackend(
    totalResponseTimeMs: number,
    usage: Pick<
      UsageLogStats,
      'outputTokens' | 'cachedInputTokens' | 'reasoningTokens' | 'cost'
    > & { cacheMissInputTokens: number; usageRoute?: UsageRoute },
    provider: NormalizedUsage['provider'],
    model: UsageMonitorModelInfo,
  ): void {
    try {
      const cachedInputTokens = usage.cachedInputTokens ?? 0;

      this.context.usageLog.log(
        {
          model: model.fullName,
          provider,
          agentName: this.metadata.agentName,
          agentCategory: this.metadata.agentCategory,
          inputTokens: usage.cacheMissInputTokens,
          outputTokens: usage.outputTokens,
          cost: roundTo(usage.cost, 6),
          responseTimeMs: Math.round(totalResponseTimeMs),
          cachedInputTokens,
          reasoningTokens: usage.reasoningTokens ?? 0,
          usageRoute: usage.usageRoute,
          // An external wire key of the usage-log edge function, the same
          // class as the CLI's NDJSON projection keys: the relay's request
          // column is still named `streamId`, so the key stays until that
          // column is renamed to `run_id` (a server-side change, not part of
          // this release). It carries the run id and no stream vocabulary
          // survives behind it.
          streamId: this.context.runId,
        },
        this.context.config,
      );
    } catch (error) {
      this.context.logger.warn('Backend usage logging failed', {
        data: error,
      });
    }
  }
}
