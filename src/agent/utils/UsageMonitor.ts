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

      const roundUsage = {
        inputTokens: latestUsage?.inputTokens ?? totals.totalInputTokens,
        outputTokens: latestUsage?.outputTokens ?? totals.totalOutputTokens,
        cachedInputTokens:
          latestUsage?.cachedInputTokens ?? totals.totalCacheReadInputTokens,
        cacheCreationTokens:
          latestUsage?.cacheCreationTokens ??
          totals.totalCacheCreationInputTokens,
        reasoningTokens:
          latestUsage?.reasoningTokens ?? totals.totalReasoningTokens,
        toolUsePromptTokens:
          latestUsage?.toolUsePromptTokens ?? totals.totalToolUsePromptTokens,
        cost: latestUsage?.cost ?? totals.totalCost,
      };

      const cachingStats =
        this.modelInfo.capabilities.supportsPromptCaching ||
        this.modelInfo.capabilities.supportsAutoPromptCaching;

      const roundCacheReadTokens = roundUsage.cachedInputTokens ?? 0;
      const roundCacheCreationTokens = roundUsage.cacheCreationTokens ?? 0;

      const totalCacheableTokens = cachingStats
        ? this.modelInfo.capabilities.supportsPromptCaching
          ? roundCacheCreationTokens + roundCacheReadTokens
          : roundUsage.inputTokens
        : 0;

      const percentageCached = cachingStats
        ? totalCacheableTokens > 0
          ? (roundCacheReadTokens / totalCacheableTokens) * 100
          : 0
        : undefined;

      // Use accumulated totals for the UI display, not per-round usage
      const baseStats: TokenUsageStats = {
        inputTokens: totals.totalInputTokens,
        outputTokens: totals.totalOutputTokens,
        cost: Number(totals.totalCost.toFixed(3)),
        // Include cache creation tokens for Anthropic (charged at 1.25x input price)
        cacheCreationInputTokens: totals.totalCacheCreationInputTokens || undefined,
      };

      const payload: ExtendedTokenUsageStats = {
        ...baseStats,
        elapsedTime: Number(
          (stateGlobal.totalResponseTimeMs / 1000).toFixed(1),
        ),
        ...(cachingStats && {
          cacheReadInputTokens: roundCacheReadTokens,
          ...(this.modelInfo.capabilities.supportsPromptCaching && {
            cacheCreationInputTokens: roundCacheCreationTokens,
          }),
          percentageCached: Number((percentageCached ?? 0).toFixed(2)),
        }),
        ...(this.modelInfo.capabilities.supportsReasoning && {
          reasoningTokens: roundUsage.reasoningTokens ?? 0,
        }),
        // Include tool usage if any is present
        ...((roundUsage.toolUsePromptTokens ?? 0) > 0 && {
          toolUseTokens: roundUsage.toolUsePromptTokens ?? 0,
        }),
      };

      // Get current storageKey via callback - handles mutable state correctly
      const storageKey = this.context.getStorageKey();
      usageReporter.report(payload, storageKey);

      // Log to backend for analytics (non-blocking, fire-and-forget)
      this.logToBackend(stateGlobal.totalResponseTimeMs, roundUsage);
    } catch (error) {
      logger.error(`Error printing ${runKind} statistics: ${error}`);
    }
  }

  /**
   * Log usage to backend for analytics.
   * Non-blocking - errors are caught and logged, never thrown.
   */
  private logToBackend(
    totalResponseTimeMs: number,
    roundUsage: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
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
      const roundInputTokens = roundUsage.inputTokens;
      const roundOutputTokens = roundUsage.outputTokens;
      const roundCachedInputTokens = roundUsage.cachedInputTokens ?? 0;
      const roundReasoningTokens = roundUsage.reasoningTokens ?? 0;
      const roundCost = roundUsage.cost;

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
