// Local imports - agent
import type { IModelHandler } from '@agent/modelHandlers';

// Internal imports
import { AgentRunState } from '@agent/core/AgentState';

// Type imports
import type {
  TokenUsageStats,
  ExtendedTokenUsageStats,
} from '@agent/types/UsageTypes';

// Internal imports
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';

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
    private readonly modelHandler: IModelHandler,
    private readonly context: AgentExecutionContext,
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
        this.modelHandler.capabilities.supportsPromptCaching ||
        this.modelHandler.capabilities.supportsAutoPromptCaching;

      const totalCacheableTokens = cachingStats
        ? this.modelHandler.capabilities.supportsPromptCaching
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
        elapsedTime: Number(stateGlobal.totalResponseTimeMs.toFixed(1)),
        ...(cachingStats && {
          cacheReadInputTokens: totals.totalCacheReadInputTokens,
          ...(this.modelHandler.capabilities.supportsPromptCaching && {
            cacheCreationInputTokens: totals.totalCacheCreationInputTokens,
          }),
          percentageCached: Number((percentageCached ?? 0).toFixed(2)),
        }),
        ...(this.modelHandler.capabilities.supportsReasoning && {
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
    } catch (error) {
      logger.error(`Error printing ${runKind} statistics: ${error}`);
    }
  }
}
