// Local imports
import { getServerSideKeyService } from '@auth/serverKeys';

// Internal imports
import { AgentCategory } from '@agent/core/AgentDataclass';
import { AgentRunState } from '@agent/core/AgentState';

// Type imports
import type { ExtendedTokenUsageStats } from '@agent/types/UsageTypes';
import { UsageProviderSchema } from '@agent/types/NormalizedUsage';

// Internal imports
import { UsageLogService } from '@logger/UsageLogService';
import type { AgentLogger } from '@logger/AgentLogger';
import type { AgentUsageReporter } from '@logger/AgentUsageReporter';
import type { ModelCapabilities, ModelConfig } from '@model';
import type { StorageKey, StreamTabId } from '@shared/schemas';
import type { TokenUsageStats } from '@shared/schemas';

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
    stateGlobal: AgentRunState,
    options?: { runKind?: UsageMonitorRunKind },
  ): Promise<void> {
    const { logger, usageReporter } = this.context;
    const runKind: UsageMonitorRunKind = options?.runKind ?? 'workflow';

    try {
      const totals = stateGlobal.usageAccumulator.getTotals();
      const latestUsageSnapshot = stateGlobal.usageAccumulator
        .getNormalizedSnapshots()
        .at(-1);
      const latestUsage = latestUsageSnapshot?.usage;

      // Per-round usage - sent to both UI (for accumulation) and backend analytics
      const roundInputTokens = latestUsage?.inputTokens ?? 0;
      const roundOutputTokens = latestUsage?.outputTokens ?? 0;
      const roundCacheReadTokens = latestUsage?.cachedInputTokens ?? 0;
      const roundCacheCreationTokens = latestUsage?.cacheCreationTokens ?? 0;
      const roundReasoningTokens = latestUsage?.reasoningTokens ?? 0;
      const roundCost = latestUsage?.cost ?? 0;

      const cachingStats =
        this.modelInfo.capabilities.supportsPromptCaching ||
        this.modelInfo.capabilities.supportsAutoPromptCaching;

      // Use accumulated totals for cache percentage calculation (for display)
      const totalCacheReadTokens = totals.totalCacheReadInputTokens;
      const totalCacheCreationTokens = totals.totalCacheCreationInputTokens;

      let totalCacheableTokens = 0;
      if (cachingStats) {
        totalCacheableTokens = this.modelInfo.capabilities.supportsPromptCaching
          ? totalCacheCreationTokens + totalCacheReadTokens
          : totals.totalInputTokens;
      }

      let percentageCached: number | undefined;
      if (cachingStats && totalCacheableTokens > 0) {
        percentageCached = (totalCacheReadTokens / totalCacheableTokens) * 100;
      } else if (cachingStats) {
        percentageCached = 0;
      }

      // Send per-round deltas - storage will accumulate them
      const baseStats: TokenUsageStats = {
        inputTokens: roundInputTokens,
        outputTokens: roundOutputTokens,
        cost: Number(roundCost.toFixed(3)),
        // Include cache tokens for display (only if > 0)
        cacheReadInputTokens:
          roundCacheReadTokens > 0 ? roundCacheReadTokens : undefined,
        cacheCreationInputTokens:
          roundCacheCreationTokens > 0 ? roundCacheCreationTokens : undefined,
      };

      const payload: ExtendedTokenUsageStats = {
        ...baseStats,
        elapsedTime: Number(
          (stateGlobal.totalResponseTimeMs / 1000).toFixed(1),
        ),
      };
      if (cachingStats) {
        payload.percentageCached = Number((percentageCached ?? 0).toFixed(2));
      }
      if (this.modelInfo.capabilities.supportsReasoning) {
        payload.reasoningTokens = roundReasoningTokens;
      }
      const toolUseTokens = latestUsage?.toolUsePromptTokens ?? 0;
      if (toolUseTokens > 0) {
        payload.toolUseTokens = toolUseTokens;
      }

      // Use activeGroupId for statistics grouping if set (round-specific),
      // otherwise fall back to storageKey (parent stage or execution ID)
      usageReporter.report(
        payload,
        this.context.storageKey,
        this.activeGroupId,
      );

      // Note: Context state is emitted by model handlers during token counting
      // (Anthropic, Google, OpenAI). This avoids duplicate emissions and ensures
      // we use the native token count which is more accurate than response usage.

      // Log to backend for analytics (non-blocking, fire-and-forget)
      const backendLogUsage = {
        inputTokens: roundInputTokens,
        outputTokens: roundOutputTokens,
        cachedInputTokens: roundCacheReadTokens,
        cacheCreationInputTokens: roundCacheCreationTokens,
        reasoningTokens: roundReasoningTokens,
        cost: roundCost,
      };
      this.logToBackend(stateGlobal.totalResponseTimeMs, backendLogUsage);
    } catch (error) {
      logger.error(`Error printing ${runKind} statistics: ${error}`);
    }
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
      });
    } catch (error) {
      this.context.logger.debug(`Backend usage logging failed: ${error}`);
    }
  }
}
