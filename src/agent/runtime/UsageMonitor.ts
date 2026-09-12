import type { AgentTrace } from '@agent/trace';
import type { RunUsageTotals } from '@agent/core/usage/RunUsageAccumulator';
import type { ModelCell } from '@agent/runtime/ModelCell';
import type {
  AgentRunStateSnapshot,
  RunId,
  ExtendedTokenUsageStats,
  UsageRoute,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import { UsageLogService } from '@telemetry/UsageLogService';
import type { UsageLogStats } from '@telemetry/UsageLogTypes';
import { roundTo } from '@utils/core';
import type { ModelCapabilities, ModelConfig } from 'llm-zoo';

/**
 * Cache-miss tokens billed for this round. Backend billing always needs a
 * real number, so it falls back to the derived estimate (input minus
 * cache-read) when the provider is silent. Display never guesses: the
 * published row carries the accumulator's reported total instead, and omits
 * the field when no provider ever reported one.
 */
function billedRoundCacheMissTokens(
  reported: number | undefined,
  roundInputTokens: number,
  roundCacheReadTokens: number,
): number {
  return reported ?? Math.max(0, roundInputTokens - roundCacheReadTokens);
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
    'supportsPromptCaching' | 'supportsAutoPromptCaching' | 'supportsReasoning'
  >;
  config: Pick<ModelConfig, 'fullName'>;
}

/**
 * Runtime dependencies for UsageMonitor — the individual run facts it reads,
 * never a whole run context:
 *
 * - logger: For error logging and the single `usage` trace event
 * - runId: The run whose usage this is; keys its usage map (immutable)
 * - runStageId: The run stage this run opened, used only to stamp the
 *   trace event when usage is logged outside an ambient stage
 */
interface UsageMonitorContext {
  logger: AgentTrace;
  runId: RunId;
  runStageId: string | undefined;
}

/** Label for the run flavor named in this monitor's diagnostics. */
type UsageMonitorRunKind = 'workflow' | 'tool-use';

/**
 * Handles recording usage statistics to the log and progress view.
 *
 * Cost is computed once during normalization and stored in the accumulator.
 * This class simply reads the pre-computed totals - no cost recomputation needed.
 *
 * The two consumers want different grains and get them from one call: the
 * session's `usage` row carries the run's cumulative totals (a snapshot, since
 * a listing read delivers only the newest row per run), while the backend is
 * billed per round.
 */
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
    const { logger, runId, runStageId } = this.context;
    const { agentCategory } = this.metadata;
    const runKind: UsageMonitorRunKind =
      agentCategory === AgentCategory.ToolUse ? 'tool-use' : 'workflow';

    try {
      const totals = stateGlobal.usageAccumulator.totals;
      this.lastSeenTotals = totals;
      const latestUsage = stateGlobal.usageAccumulator.latestUsage;
      if (!latestUsage) return;

      // Per-round usage - billed to the backend, which accounts per round.
      const roundInputTokens = latestUsage.inputTokens;
      const roundOutputTokens = latestUsage.outputTokens;
      const roundCacheReadTokens = latestUsage.cachedInputTokens ?? 0;
      const roundReasoningTokens = latestUsage.reasoningTokens ?? 0;
      const roundCost = latestUsage.cost;
      const usageRoute = latestUsage.usageRoute ?? 'api-key';
      const roundCacheMissTokens = billedRoundCacheMissTokens(
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

      // The `usage` row is a snapshot fact, not a delta: `usage` is a
      // latest-only listing key, so a cold read delivers exactly one row per
      // run and the fold replaces the run's total with it. Every field here
      // is therefore the run's total so far, read off the accumulator —
      // `elapsedTime` and `percentageCached` already were.
      const payload: ExtendedTokenUsageStats = {
        inputTokens: totals.totalInputTokens,
        outputTokens: totals.totalOutputTokens,
        cost: roundTo(totals.totalCost, 3),
        elapsedTime: roundTo(stateGlobal.totalResponseTimeMs / 1000, 1),
        ...(totals.totalCacheReadInputTokens > 0 && {
          cacheReadInputTokens: totals.totalCacheReadInputTokens,
        }),
        // Only reported cache-miss tokens reach the totals, so a zero here
        // means no provider ever reported one: omit rather than guess.
        ...(totals.totalCacheMissInputTokens > 0 && {
          cacheMissInputTokens: totals.totalCacheMissInputTokens,
        }),
        ...(totals.totalCacheCreationInputTokens > 0 && {
          cacheCreationInputTokens: totals.totalCacheCreationInputTokens,
        }),
        ...(supportsCaching && {
          percentageCached: roundTo(percentageCached, 2),
        }),
        ...(capabilities.supportsReasoning && {
          reasoningTokens: totals.totalReasoningTokens,
        }),
        ...(totals.totalToolUsePromptTokens > 0 && {
          toolUseTokens: totals.totalToolUsePromptTokens,
        }),
        usageRoute,
      };

      // One typed trace event feeds both transcript and progress projections.
      logger.usage(
        { runId, usage: payload },
        {
          recordTranscript: agentCategory === AgentCategory.Workflow,
          // The ambient stage's AsyncLocalStorage scope stamps its structural
          // id onto emitted events; fall back to this run's own stage when
          // usage is logged outside a stage.
          stageId: logger.activeStageId() ?? runStageId,
        },
      );

      // Log to backend for analytics/billing.
      this.logToBackend(
        stateGlobal.totalResponseTimeMs,
        {
          inputTokens: roundInputTokens,
          outputTokens: roundOutputTokens,
          cachedInputTokens: roundCacheReadTokens,
          cacheMissInputTokens: roundCacheMissTokens,
          reasoningTokens: roundReasoningTokens,
          cost: roundCost,
          usageRoute,
        },
        latestUsage.provider,
      );
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

  /**
   * Log per-round usage to backend for analytics/billing.
   * Errors are caught and logged, never thrown.
   */
  private logToBackend(
    totalResponseTimeMs: number,
    usage: Pick<
      UsageLogStats,
      | 'inputTokens'
      | 'outputTokens'
      | 'cachedInputTokens'
      | 'reasoningTokens'
      | 'cost'
    > & { cacheMissInputTokens: number; usageRoute?: UsageRoute },
    provider: NonNullable<
      AgentRunStateSnapshot['usageAccumulator']['latestUsage']
    >['provider'],
  ): void {
    try {
      const { config } = this.modelInfo;
      const cachedInputTokens = usage.cachedInputTokens ?? 0;

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
        usageRoute: usage.usageRoute,
        // The relay's request column is still named `streamId`; this is the
        // last production spelling of the word outside the token-stream
        // sense, and it stays until the relay column is renamed (a
        // server-side change, not part of this release).
        streamId: this.context.runId,
      });
    } catch (error) {
      this.context.logger.warn('Backend usage logging failed', {
        data: error,
      });
    }
  }
}
