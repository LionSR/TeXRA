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
 * ## RunId Resolution
 * - Workflow agents: Uses task group ID from logger hierarchy (via usageReporter)
 * - Tool-use agents: Uses executionId as the runId (no task groups exist)
 *
 * @see IdentifierTypes.ts for the full execution model documentation
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

      // For tool-use agents: ExecutionId IS the RunId (no task groups exist).
      // Fallback to streamId only for legacy sessions without executionId.
      const runId = this.context.executionId ?? this.context.streamId;
      usageReporter.report(payload, runId);
    } catch (error) {
      logger.error(`Error printing ${runKind} statistics: ${error}`);
    }
  }
}
