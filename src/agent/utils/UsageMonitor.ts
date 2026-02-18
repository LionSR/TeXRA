// Local imports
import { getServerSideKeyService } from '@auth/serverKeys';

// Internal imports
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { AgentRunStateSnapshot } from '@agent/core/AgentState';
import type { RunUsageTotals } from '@agent/core/RunUsageAccumulator';
import { UsageProviderSchema } from '@agent/types/NormalizedUsage';
import {
  UsageLogService,
  type AgentLogger,
  type AgentUsageReporter,
  type UsageLogRound,
} from '@logger/index';
import type { ModelCapabilities, ModelConfig } from 'llm-zoo';
import type {
  ExtendedTokenUsageStats,
  StorageKey,
  StreamTabId,
  TokenUsageStats,
} from '@shared/schemas';

/**
 * Optional metadata for usage logging.
 */
export interface UsageMonitorMetadata {
  /** Agent name for backend logging */
  agentName?: string;
  /** Agent category: workflow or toolUse */
  agentCategory?: AgentCategory;
  /** Whether this is a multiple-output workflow agent */
  isMultipleOutput?: boolean;
}

/**
 * Minimal model info needed for usage tracking.
 *
 * This interface captures only the fields UsageMonitor actually uses,
 * eliminating the need to store a full IModelHandler reference.
 * Fields are directly from ModelCapabilities and ModelConfig.
 */
export interface UsageMonitorModelInfo {
  capabilities: Pick<
    ModelCapabilities,
    | 'supportsPromptCaching'
    | 'supportsAutoPromptCaching'
    | 'supportsReasoning'
    | 'cacheDiscountFactor'
  >;
  config: Pick<ModelConfig, 'provider' | 'name' | 'fullName' | 'inputPrice'>;
}

/**
 * Runtime dependencies for UsageMonitor.
 *
 * Takes individual fields instead of full AgentExecutionContext:
 * - logger: For error logging
 * - usageReporter: For reporting usage to UI
 * - storageKey: The storage key for this execution (immutable)
 * - streamId: For backend logging
 */
export interface UsageMonitorContext {
  logger: AgentLogger;
  usageReporter: AgentUsageReporter;
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
   * Active group ID for statistics logging.
   * When set, statistics are logged with this group ID instead of storageKey.
   * This allows statistics to be associated with individual rounds (r0, r1)
   * rather than the parent stage.
   */
  private activeGroupId: string | undefined;

  /**
   * Accumulated per-round usage snapshots.
   * Instead of logging each round to the backend individually, we collect
   * snapshots and flush once when the agent execution completes.
   * This reduces N database rows per tool-use run down to 1.
   */
  private accumulatedRounds: UsageLogRound[] = [];
  private accumulatedResponseTimeMs = 0;

  constructor(
    private readonly modelInfo: UsageMonitorModelInfo,
    private readonly context: UsageMonitorContext,
    private readonly metadata?: UsageMonitorMetadata,
  ) {}

  /**
   * Set the active group ID for statistics logging.
   * Call this when entering a new round to associate statistics with that round.
   *
   * @param groupId - The round stage ID (e.g., r0, r1) or undefined to use storageKey
   */
  setActiveGroupId(groupId: string | undefined): void {
    this.activeGroupId = groupId;
  }

  async recordUsage(
    stateGlobal: AgentRunStateSnapshot,
    options?: { runKind?: UsageMonitorRunKind },
  ): Promise<void> {
    const { logger, usageReporter } = this.context;
    const runKind: UsageMonitorRunKind = options?.runKind ?? 'workflow';

    try {
      const totals = stateGlobal.usageAccumulator.totals;
      const latestUsage =
        stateGlobal.usageAccumulator.normalizedSnapshots.at(-1)?.usage;

      // Per-round usage - sent to both UI (for accumulation) and backend analytics
      const roundInputTokens = latestUsage?.inputTokens ?? 0;
      const roundOutputTokens = latestUsage?.outputTokens ?? 0;
      const roundCacheReadTokens = latestUsage?.cachedInputTokens ?? 0;
      const roundCacheCreationTokens = latestUsage?.cacheCreationTokens ?? 0;
      const roundReasoningTokens = latestUsage?.reasoningTokens ?? 0;
      const roundCost = latestUsage?.cost ?? 0;
      const toolUseTokens = latestUsage?.toolUsePromptTokens ?? 0;

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
        cost: Number(roundCost.toFixed(3)),
        elapsedTime: Number(
          (stateGlobal.totalResponseTimeMs / 1000).toFixed(1),
        ),
        ...(roundCacheReadTokens > 0 && {
          cacheReadInputTokens: roundCacheReadTokens,
        }),
        ...(roundCacheCreationTokens > 0 && {
          cacheCreationInputTokens: roundCacheCreationTokens,
        }),
        ...(supportsCaching && {
          percentageCached: Number(percentageCached.toFixed(2)),
        }),
        ...(capabilities.supportsReasoning && {
          reasoningTokens: roundReasoningTokens,
        }),
        ...(toolUseTokens > 0 && { toolUseTokens }),
      };

      usageReporter.report(
        payload,
        this.context.storageKey,
        this.activeGroupId,
      );

      // Accumulate per-round snapshot (flushed once at end of agent execution)
      // Store per-round delta time, not cumulative total
      const roundResponseTimeMs =
        stateGlobal.totalResponseTimeMs - this.accumulatedResponseTimeMs;
      this.accumulatedRounds.push({
        inputTokens: roundInputTokens,
        outputTokens: roundOutputTokens,
        cachedInputTokens: roundCacheReadTokens,
        cacheCreationInputTokens: roundCacheCreationTokens,
        reasoningTokens: roundReasoningTokens,
        cost: roundCost,
        responseTimeMs: roundResponseTimeMs,
      });
      this.accumulatedResponseTimeMs = stateGlobal.totalResponseTimeMs;
    } catch (error) {
      logger.error(`Error printing ${runKind} statistics: ${error}`);
    }
  }

  /**
   * Flush accumulated usage to backend as a single aggregated record.
   * Call this once after the agent flow completes (not per-round).
   * Produces one DB row with summed totals and a `rounds` JSONB array
   * preserving per-cycle granularity.
   */
  flushToBackend(): void {
    if (this.accumulatedRounds.length === 0) return;

    const rounds = this.accumulatedRounds;
    const totalResponseTimeMs = this.accumulatedResponseTimeMs;
    this.accumulatedRounds = [];
    this.accumulatedResponseTimeMs = 0;

    const totals = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
      cost: 0,
    };

    for (const r of rounds) {
      totals.inputTokens += r.inputTokens;
      totals.outputTokens += r.outputTokens;
      totals.cachedInputTokens += r.cachedInputTokens ?? 0;
      totals.cacheCreationInputTokens += r.cacheCreationInputTokens ?? 0;
      totals.reasoningTokens += r.reasoningTokens ?? 0;
      totals.cost += r.cost;
    }

    this.logToBackend(totalResponseTimeMs, totals, {
      roundCount: rounds.length,
      rounds,
    });
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
   * Non-blocking - errors are caught and logged, never thrown.
   */
  private logToBackend(
    totalResponseTimeMs: number,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      cacheCreationInputTokens?: number;
      reasoningTokens?: number;
      cost: number;
    },
    aggregation?: {
      roundCount: number;
      rounds: UsageLogRound[];
    },
  ): void {
    try {
      const { config } = this.modelInfo;
      const provider = UsageProviderSchema.catch('unknown').parse(
        config.provider.toLowerCase(),
      );
      const cachedInputTokens = usage.cachedInputTokens ?? 0;

      UsageLogService.log({
        model: config.fullName,
        provider,
        agentName: this.metadata?.agentName,
        agentCategory: this.metadata?.agentCategory,
        isMultipleOutput: this.metadata?.isMultipleOutput,
        inputTokens: Math.max(0, usage.inputTokens - cachedInputTokens),
        outputTokens: usage.outputTokens,
        cost: Number(usage.cost.toFixed(6)),
        responseTimeMs: Math.round(totalResponseTimeMs),
        cachedInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
        reasoningTokens: usage.reasoningTokens ?? 0,
        usedRelay: getServerSideKeyService().shouldUseServerSideKeysSync(
          config.provider,
          config.name,
        ),
        streamId: this.context.streamId,
        roundCount: aggregation?.roundCount,
        rounds: aggregation?.rounds,
      });
    } catch (error) {
      this.context.logger.debug(`Backend usage logging failed: ${error}`);
    }
  }
}
