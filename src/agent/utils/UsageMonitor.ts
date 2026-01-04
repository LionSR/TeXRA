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
import { UsageProviderSchema } from '@agent/types/NormalizedUsage';

// Internal imports
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import { UsageLogService } from '@logger/UsageLogService';
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
    'supportsPromptCaching' | 'supportsAutoPromptCaching' | 'supportsReasoning'
  >;
  config: Pick<ModelConfig, 'provider' | 'name' | 'fullName'>;
}

/**
 * Handles recording usage statistics to the log and progress view.
 *
 * Cost is computed once during normalization and stored in the accumulator.
 * This class simply reads the pre-computed totals - no cost recomputation needed.
 *
 * ## Storage Key Resolution
 * Uses context.storageKey which is already computed:
 * - Workflow agents: storageKey = task group ID
 * - Tool-use agents: storageKey = executionId
 *
 * @see ExecutionIdentity for the unified identity model
 */
type UsageMonitorRunKind = 'workflow' | 'tool-use';

export class UsageMonitor {
  constructor(
    private readonly modelInfo: UsageMonitorModelInfo,
    private readonly context: AgentExecutionContext,
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

      // Cost is already computed and stored in totals - no need to recompute!
      const cost = totals.totalCost;

      const cachingStats =
        this.modelInfo.capabilities.supportsPromptCaching ||
        this.modelInfo.capabilities.supportsAutoPromptCaching;

      const totalCacheableTokens = cachingStats
        ? this.modelInfo.capabilities.supportsPromptCaching
          ? totals.totalCacheCreationInputTokens +
            totals.totalCacheReadInputTokens
          : totals.totalInputTokens
        : 0;

      const percentageCached = cachingStats
        ? totalCacheableTokens > 0
          ? (totals.totalCacheReadInputTokens / totalCacheableTokens) * 100
          : 0
        : undefined;

      const baseStats: TokenUsageStats = {
        inputTokens: totals.totalInputTokens,
        outputTokens: totals.totalOutputTokens,
        cost: Number(cost.toFixed(3)),
      };

      const payload: ExtendedTokenUsageStats = {
        ...baseStats,
        elapsedTime: Number(
          (stateGlobal.totalResponseTimeMs / 1000).toFixed(1),
        ),
        ...(cachingStats && {
          cacheReadInputTokens: totals.totalCacheReadInputTokens,
          ...(this.modelInfo.capabilities.supportsPromptCaching && {
            cacheCreationInputTokens: totals.totalCacheCreationInputTokens,
          }),
          percentageCached: Number((percentageCached ?? 0).toFixed(2)),
        }),
        ...(this.modelInfo.capabilities.supportsReasoning && {
          reasoningTokens: totals.totalReasoningTokens,
        }),
        // Include tool usage if any is present
        ...(totals.totalToolUsePromptTokens > 0 && {
          toolUseTokens: totals.totalToolUsePromptTokens,
        }),
      };

      // Use storageKey from context - already computed correctly for both
      // workflow agents (task group ID) and tool-use agents (executionId)
      const storageKey = this.context.storageKey;
      usageReporter.report(payload, storageKey);

      // Log to backend for analytics (non-blocking, fire-and-forget)
      this.logToBackend(totals, stateGlobal.totalResponseTimeMs);
    } catch (error) {
      logger.error(`Error printing ${runKind} statistics: ${error}`);
    }
  }

  /**
   * Log usage to backend for analytics.
   * Non-blocking - errors are caught and logged, never thrown.
   */
  private logToBackend(
    totals: ReturnType<AgentRunState['usageAccumulator']['getTotals']>,
    totalResponseTimeMs: number,
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

      UsageLogService.log({
        model: config.fullName,
        provider,
        agentName: this.metadata?.agentName,
        agentCategory: this.metadata?.agentCategory,
        isMultipleOutput: this.metadata?.isMultipleOutput,
        inputTokens: totals.totalInputTokens,
        outputTokens: totals.totalOutputTokens,
        cost: Number(totals.totalCost.toFixed(6)),
        responseTimeMs: Math.round(totalResponseTimeMs),
        cachedInputTokens: totals.totalCacheReadInputTokens,
        reasoningTokens: totals.totalReasoningTokens,
        usedRelay,
        streamId: this.context.streamId,
      });
    } catch (error) {
      // Silently ignore backend logging errors - this should never block the main flow
      this.context.logger.debug(`Backend usage logging failed: ${error}`);
    }
  }
}
