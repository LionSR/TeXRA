import type { AgentTrace } from '@agent/trace';
import type { AgentRunStateSnapshot } from '@agent/core/state/AgentState';
import type { RunUsageTotals } from '@agent/core/usage/RunUsageAccumulator';
import { usesServerSideKeysRoute } from '@agent/modelHandlers/support/ProxyConfigResolver';
import type { ModelCell } from '@agent/runtime/ModelCell';
import type {
  ExtendedTokenUsageStats,
  StorageKey,
  StreamTabId,
  UsageRoute,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import { UsageProviderSchema } from '@shared/schemas/usage';
import {
  USAGE_LOG_FLUSH_OUTCOME,
  UsageLogService,
} from '@telemetry/UsageLogService';
import type { UsageLogStats } from '@telemetry/UsageLogTypes';
import { roundTo } from '@utils/core';
import type { ModelCapabilities, ModelConfig } from 'llm-zoo';

/**
 * Cache-miss tokens for this round, resolved once for both consumers of
 * per-round usage:
 * - UI display omits the field entirely when the provider didn't report it
 *   (never shows a guessed number), and also when it's exactly zero.
 * - Backend billing always needs a real number, so it falls back to the
 *   derived estimate (input minus cache-read) when the provider is silent.
 */
function resolveRoundCacheMissTokens(
  reported: number | undefined,
  roundInputTokens: number,
  roundCacheReadTokens: number,
): { display: number | undefined; billing: number } {
  return {
    display: reported && reported > 0 ? reported : undefined,
    billing: reported ?? Math.max(0, roundInputTokens - roundCacheReadTokens),
  };
}

/**
 * Metadata for usage logging. Required because `agentCategory` controls
 * the `runKind` derivation in `recordUsage` — a silent default would
 * misreport usage runs from a future caller that forgot to set it.
 */
interface UsageMonitorMetadata {
  /** Agent name for backend logging */
  agentName: string;
  /** Agent category: workflow or toolUse */
  agentCategory: AgentCategory;
}

/**
 * Minimal model info needed for usage tracking.
 *
 * This interface names the fields UsageMonitor reads off the run's live model
 * handler, so widening what usage accounting depends on is a visible edit here.
 * Fields are directly from ModelCapabilities and ModelConfig.
 */
interface UsageMonitorModelInfo {
  capabilities: Pick<
    ModelCapabilities,
    | 'supportsPromptCaching'
    | 'supportsAutoPromptCaching'
    | 'supportsReasoning'
    | 'cacheDiscountFactor'
  >;
  config: Pick<
    ModelConfig,
    | 'provider'
    | 'name'
    | 'fullName'
    | 'inputPrice'
    | 'openRouterOnly'
    | 'requiresResponsesAPI'
  >;
}

/**
 * Runtime dependencies for UsageMonitor.
 *
 * Takes individual fields instead of full AgentExecutionContext:
 * - logger: For error logging and the single `usage` trace event
 * - storageKey: The storage key for this execution (immutable)
 * - streamId: For backend logging
 */
interface UsageMonitorContext {
  logger: AgentTrace;
  storageKey: StorageKey;
  streamId: StreamTabId;
}

/**
 * Handles recording usage statistics to the log and progress view.
 *
 * Cost is computed once during normalization and stored in the accumulator.
 * This class simply reads the pre-computed totals - no cost recomputation needed.
 */
type UsageMonitorRunKind = 'workflow' | 'tool-use';

export class UsageMonitor {
  /**
   * The most recent run totals seen by {@link recordUsage}. Cached so a failed
   * run can still report usage on its terminal `result` event (the catch arm
   * has no flow result to read totals from). Undefined before the first round.
   */
  private lastSeenTotals: RunUsageTotals | undefined;

  constructor(
    private readonly modelCell: ModelCell,
    private readonly context: UsageMonitorContext,
    private readonly metadata: UsageMonitorMetadata,
  ) {}

  /**
   * The model this run is live on. Read from the cell on every use, so a
   * mid-run model switch is priced and reported against the model that
   * actually served the round without anyone mirroring it back in.
   */
  private get modelInfo(): UsageMonitorModelInfo {
    return this.modelCell.handler;
  }

  /** The last run totals recorded this run, or undefined before any round. */
  lastTotals(): RunUsageTotals | undefined {
    return this.lastSeenTotals;
  }

  async recordUsage(stateGlobal: AgentRunStateSnapshot): Promise<void> {
    const { logger, storageKey, streamId } = this.context;
    const { agentCategory } = this.metadata;
    const runKind: UsageMonitorRunKind =
      agentCategory === AgentCategory.ToolUse ? 'tool-use' : 'workflow';

    try {
      const totals = stateGlobal.usageAccumulator.totals;
      this.lastSeenTotals = totals;
      const latestUsage = stateGlobal.usageAccumulator.latestUsage;
      if (!latestUsage) return;

      // Per-round usage - sent to both UI (for accumulation) and backend analytics
      const roundInputTokens = latestUsage.inputTokens;
      const roundOutputTokens = latestUsage.outputTokens;
      const roundCacheReadTokens = latestUsage.cachedInputTokens ?? 0;
      const roundCacheCreationTokens = latestUsage.cacheCreationTokens ?? 0;
      const roundReasoningTokens = latestUsage.reasoningTokens ?? 0;
      const roundCost = latestUsage.cost;
      const toolUseTokens = latestUsage.toolUsePromptTokens ?? 0;
      const usageRoute = latestUsage.usageRoute ?? this.currentUsageRoute();
      const roundCacheMissTokens = resolveRoundCacheMissTokens(
        latestUsage.cacheMissInputTokens,
        roundInputTokens,
        roundCacheReadTokens,
      );

      const { capabilities } = this.modelInfo;
      const supportsCaching =
        capabilities.supportsPromptCaching ||
        capabilities.supportsAutoPromptCaching;

      // Calculate cache percentage for display
      const percentageCached = this.calculateCachePercentage(
        supportsCaching,
        totals,
      );

      // Build payload for UI
      const payload: ExtendedTokenUsageStats = {
        inputTokens: roundInputTokens,
        outputTokens: roundOutputTokens,
        cost: roundTo(roundCost, 3),
        elapsedTime: roundTo(stateGlobal.totalResponseTimeMs / 1000, 1),
        ...(roundCacheReadTokens > 0 && {
          cacheReadInputTokens: roundCacheReadTokens,
        }),
        ...(roundCacheMissTokens.display !== undefined && {
          cacheMissInputTokens: roundCacheMissTokens.display,
        }),
        ...(roundCacheCreationTokens > 0 && {
          cacheCreationInputTokens: roundCacheCreationTokens,
        }),
        ...(supportsCaching && {
          percentageCached: roundTo(percentageCached, 2),
        }),
        ...(capabilities.supportsReasoning && {
          reasoningTokens: roundReasoningTokens,
        }),
        ...(toolUseTokens > 0 && { toolUseTokens }),
        ...(usageRoute != null && { usageRoute }),
      };

      // One typed trace event feeds both transcript and progress projections.
      logger.usage(
        {
          streamId,
          storageKey,
          usage: payload,
        },
        {
          recordTranscript: agentCategory === AgentCategory.Workflow,
          // The round stage's AsyncLocalStorage scope already stamps the active
          // round id (r0/r1...) onto emitted events; fall back to storageKey for
          // any usage logged outside a round stage.
          stageId: logger.activeStageId() ?? storageKey,
        },
      );

      // Log to backend for analytics/billing. Relay-backed rounds wait for the
      // flush because the next relay request enforces the cap from DB state.
      await this.logToBackend(stateGlobal.totalResponseTimeMs, {
        inputTokens: roundInputTokens,
        outputTokens: roundOutputTokens,
        cachedInputTokens: roundCacheReadTokens,
        cacheMissInputTokens: roundCacheMissTokens.billing,
        reasoningTokens: roundReasoningTokens,
        cost: roundCost,
        usageRoute,
      });
    } catch (error) {
      logger.error(`Error printing ${runKind} statistics`, { data: error });
    }
  }

  /**
   * Calculate cache percentage based on model capabilities and totals.
   */
  private calculateCachePercentage(
    supportsCaching: boolean,
    totals: RunUsageTotals,
  ): number {
    if (!supportsCaching) return 0;

    const totalCacheableTokens = this.modelInfo.capabilities
      .supportsPromptCaching
      ? totals.totalCacheCreationInputTokens + totals.totalCacheReadInputTokens
      : totals.totalInputTokens;

    if (totalCacheableTokens === 0) return 0;
    return (totals.totalCacheReadInputTokens / totalCacheableTokens) * 100;
  }

  private currentUsageRoute(): UsageRoute | undefined {
    try {
      // Shares ModelHandler's runtime combinator (#7101 triage) rather than
      // re-deriving the same `!openRouter && relaySync` formula independently
      // — `IModelHandler` does not expose `shouldUseServerSideKeys()`, so the
      // config-shaped combinator is what this class can call.
      return usesServerSideKeysRoute(this.modelInfo.config)
        ? 'relay'
        : 'api-key';
    } catch (error) {
      this.context.logger.debug('Usage route relay check failed', {
        data: error,
      });
      return undefined;
    }
  }

  /**
   * Log per-round usage to backend for analytics/billing.
   * Errors are caught and logged, never thrown.
   */
  private async logToBackend(
    totalResponseTimeMs: number,
    usage: Pick<
      UsageLogStats,
      | 'inputTokens'
      | 'outputTokens'
      | 'cachedInputTokens'
      | 'reasoningTokens'
      | 'cost'
    > & { cacheMissInputTokens: number; usageRoute?: UsageRoute },
  ): Promise<void> {
    try {
      const { config } = this.modelInfo;
      const provider = UsageProviderSchema.catch('unknown').parse(
        config.provider.toLowerCase(),
      );
      const cachedInputTokens = usage.cachedInputTokens ?? 0;
      const usedRelay = usage.usageRoute === 'relay';

      UsageLogService.log({
        model: config.fullName,
        provider,
        agentName: this.metadata.agentName,
        agentCategory: this.metadata.agentCategory,
        inputTokens: usage.cacheMissInputTokens,
        outputTokens: usage.outputTokens,
        cost: roundTo(usage.cost, 6),
        responseTimeMs: Math.round(totalResponseTimeMs),
        cachedInputTokens,
        reasoningTokens: usage.reasoningTokens ?? 0,
        usedRelay,
        ...(usage.usageRoute != null && { usageRoute: usage.usageRoute }),
        streamId: this.context.streamId,
      });

      // The relay enforces the monthly spend cap from the server-side usage
      // total, which is only as fresh as the last flush (otherwise batched
      // every ~30s / 10 entries). For relay rounds, flush now so the relay's
      // pre-call check sees this round's cost before the next call — bounding
      // free-tier overage to roughly one round instead of a whole session.
      if (usedRelay) {
        const flushOutcome = await UsageLogService.flush();
        if (flushOutcome === USAGE_LOG_FLUSH_OUTCOME.PENDING) {
          this.context.logger.debug(
            'Relay usage logging is queued; spend-cap data will retry later.',
          );
        } else if (flushOutcome === USAGE_LOG_FLUSH_OUTCOME.REJECTED) {
          this.context.logger.error(
            'Relay usage logging was permanently rejected; spend-cap accounting is incomplete.',
          );
        }
      }
    } catch (error) {
      this.context.logger.debug('Backend usage logging failed', {
        data: error,
      });
    }
  }
}
