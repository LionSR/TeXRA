// Local imports - agent
import { AgentRunState } from '@agent/core/AgentState';
import type { IModelHandler } from '@agent/modelHandlers';
import type {
  TokenUsageStats,
  ExtendedTokenUsageStats,
} from '@agent/types/UsageTypes';
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';

/**
 * Handles recording usage statistics to the log and progress view.
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
      const nativeSnapshots =
        stateGlobal.usageAccumulator.getNativeUsageSnapshots();

      const cost = nativeSnapshots.reduce((runningTotal, snapshot) => {
        try {
          return (
            runningTotal +
            this.modelHandler.computePrice(snapshot.payload as any)
          );
        } catch (error) {
          logger.debug(
            `Failed to compute ${runKind} cost for round ${snapshot.round}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return runningTotal;
        }
      }, 0);

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
        ...(totals.totalToolUseTokens > 0 && {
          toolUseTokens: totals.totalToolUseTokens,
        }),
      };

      usageReporter.report(payload);
    } catch (error) {
      logger.error(`Error printing statistics: ${error}`);
    }
  }
}
