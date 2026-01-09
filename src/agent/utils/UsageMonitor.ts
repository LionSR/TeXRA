// Local imports
import { getServerSideKeyService } from '@auth/serverKeys';

// Internal imports
import { AgentCategory } from '@agent/core/AgentDataclass';
import { AgentRunState } from '@agent/core/AgentState';

// Type imports
import type {
  TokenUsageStats,
  ExtendedTokenUsageStats,
} from '@agent/types/UsageTypes';
import type { StorageKey, StreamTabId } from '@agent/types/IdentifierTypes';
import { UsageProviderSchema } from '@agent/types/NormalizedUsage';

// Internal imports
import { UsageLogService } from '@logger/UsageLogService';
import type { AgentLogger } from '@logger/AgentLogger';
import type { AgentUsageReporter } from '@logger/AgentUsageReporter';
import type { ModelCapabilities, ModelConfig } from '@model';

/**
 * Optional metadata for usage logging.
 */
export interface UsageMonitorMetadata {
  /** Agent name for backend logging */
  agentName?: string;
  /** Agent category: workflow or toolUse */
  agentCategory?: `${AgentCategory}`;
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
 * - getStorageKey: Callback to get current storage key (handles mutable state)
 * - streamId: For backend logging
 */
export interface UsageMonitorContext {
  logger: AgentLogger;
  usageReporter: AgentUsageReporter;
  getStorageKey: () => StorageKey;
  streamId: StreamTabId;
}

/**
 * Handles recording usage statistics to the log and progress view.
 *
 * Cost is computed once during normalization and stored in the accumulator.
 * This class simply reads the pre-computed totals - no cost recomputation needed.
 *
 * ## Storage Key Resolution
 * Uses getStorageKey() callback which returns the correct key:
 * - Workflow agents: storageKey = task group ID
 * - Tool-use agents: storageKey = executionId
 */
type UsageMonitorRunKind = 'workflow' | 'tool-use';

export class UsageMonitor {
  constructor(
    private readonly modelInfo: UsageMonitorModelInfo,
    private readonly context: UsageMonitorContext,
    private readonly metadata?: UsageMonitorMetadata,
  ) {}

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

      const totalCacheableTokens = cachingStats
        ? this.modelInfo.capabilities.supportsPromptCaching
          ? totalCacheCreationTokens + totalCacheReadTokens
          : totals.totalInputTokens
        : 0;

      const percentageCached = cachingStats
        ? totalCacheableTokens > 0
          ? (totalCacheReadTokens / totalCacheableTokens) * 100
          : 0
        : undefined;

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
        ...(cachingStats && {
          percentageCached: Number((percentageCached ?? 0).toFixed(2)),
        }),
        ...(this.modelInfo.capabilities.supportsReasoning && {
          reasoningTokens: roundReasoningTokens,
        }),
        // Include tool usage if any is present
        ...((latestUsage?.toolUsePromptTokens ?? 0) > 0 && {
          toolUseTokens: latestUsage?.toolUsePromptTokens ?? 0,
        }),
      };

      // Get current storageKey via callback - handles mutable state correctly
      const storageKey = this.context.getStorageKey();
      usageReporter.report(payload, storageKey);

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

      // Validate provider against schema, fallback to 'unknown' if invalid
      const providerLower = config.provider.toLowerCase();
      const provider =
        UsageProviderSchema.catch('unknown').parse(providerLower);

      // Check if server-side keys (relay) were used for this request
      const usedRelay = getServerSideKeyService().shouldUseServerSideKeysSync(
        config.provider,
        config.name,
      );

      // Relay billing should only reflect the current round's net tokens and cost
      // rather than cumulative history. Downstream dashboards should treat each
      // entry as a single round; if cumulative views are needed, aggregate by
      // streamId/task.
      const roundInputTokens = usage.inputTokens;
      const roundOutputTokens = usage.outputTokens;
      const roundCachedInputTokens = usage.cachedInputTokens ?? 0;
      const roundCacheCreationTokens = usage.cacheCreationInputTokens ?? 0;
      const roundReasoningTokens = usage.reasoningTokens ?? 0;
      const roundCost = usage.cost;

      const netInputTokens = Math.max(
        0,
        roundInputTokens - roundCachedInputTokens,
      );

      // roundCost already includes any cache discounts from the provider;
      // avoid double-subtracting cached tokens here.
      const relayCost = roundCost;

      UsageLogService.log({
        model: config.fullName,
        provider,
        agentName: this.metadata?.agentName,
        agentCategory: this.metadata?.agentCategory,
        isMultipleOutput: this.metadata?.isMultipleOutput,
        inputTokens: netInputTokens,
        outputTokens: roundOutputTokens,
        cost: Number(relayCost.toFixed(6)),
        responseTimeMs: Math.round(totalResponseTimeMs),
        cachedInputTokens: roundCachedInputTokens,
        cacheCreationInputTokens: roundCacheCreationTokens,
        reasoningTokens: roundReasoningTokens,
        usedRelay,
        streamId: this.context.streamId,
      });
    } catch (error) {
      // Silently ignore backend logging errors - this should never block the main flow
      this.context.logger.debug(`Backend usage logging failed: ${error}`);
    }
  }
}
