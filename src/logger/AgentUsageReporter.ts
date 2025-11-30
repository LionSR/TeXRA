// Local imports - agent types
import type { StorageKey, StreamTabId } from '@agent/types/IdentifierTypes';
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
   * @param stats - Token usage statistics to report
   * @param storageKey - THE key for storage (from context.storageKey)
   */
  public report(stats: ExtendedTokenUsageStats, storageKey?: string): void {
    const logStatistics = this.agentCategory === AgentCategory.Workflow;

    // Get the current task group ID for workflow agents
    // For tool-use agents, this will be undefined and we use the passed storageKey
    const groupId = this.logger.withCurrentGroup((id) => id);

    // Pass through usage without modification
    const usage = {
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      cost: stats.cost,
    };

    // Use groupId if available (workflow agents within a task group),
    // otherwise use the passed storageKey (tool-use agents or outside group context)
    const targetKey = (groupId ?? storageKey) as StorageKey | undefined;

    // Always emit to the single source of truth (UsageStatsManager)
    if (targetKey) {
      bus.emit('updateStreamUsage', {
        stream: this.streamId,
        storageKey: targetKey,
        runId: targetKey, // Backward compatibility
        usage,
      });
    }

    // Log detailed statistics for display in the progress view
    if (logStatistics) {
      this.logger.statistics(stats, groupId);
    }
  }
}
