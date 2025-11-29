// Local imports - agent types
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { ExtendedTokenUsageStats } from '@agent/types/UsageTypes';
import { AgentCategory } from '@agent/core/AgentDataclass';

// Internal imports
import { bus } from '@eventBus/ProgressEventBus';

// Local imports - logger
import { AgentLogger } from './AgentLogger';

/**
 * Bridges usage statistics from model handlers into log transport events.
 *
 * Usage data flows through without modification - cost and token counts
 * are already computed upstream in the model handlers.
 */
export class AgentUsageReporter {
  constructor(
    private readonly logger: AgentLogger,
    private readonly streamId: StreamTabId,
    private readonly agentCategory: AgentCategory = AgentCategory.Workflow,
  ) {}

  /**
   * Emit usage data to the progress view and attach detailed stats to the log.
   *
   * Usage flows to a single source of truth (UsageStatsManager) via updateStreamUsage.
   * Detailed statistics are logged separately for display in the progress view.
   *
   * The groupId from the logger is the authoritative run identifier - it matches
   * the TaskGroup ID that the frontend uses for activeRunId. The passed runId
   * (executionId) is only used as a fallback when no group context exists.
   */
  public report(stats: ExtendedTokenUsageStats, runId?: string): void {
    const logStatistics = this.agentCategory === AgentCategory.Workflow;

    // Get the current task group ID - this is what the frontend uses as activeRunId
    const groupId = this.logger.withCurrentGroup((id) => id);

    // Pass through usage without modification
    const usage = {
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      cost: stats.cost,
    };

    // Use groupId as the authoritative run identifier, fall back to passed runId
    const targetRunId = groupId ?? runId;

    // Always emit to the single source of truth (UsageStatsManager)
    if (targetRunId) {
      bus.emit('updateStreamUsage', {
        stream: this.streamId,
        runId: targetRunId,
        usage,
      });
    }

    // Log detailed statistics for display in the progress view
    if (logStatistics) {
      this.logger.statistics(stats, groupId);
    }
  }
}
