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
 */
export class AgentUsageReporter {
  constructor(
    private readonly logger: AgentLogger,
    private readonly streamId: StreamTabId,
    private readonly agentCategory: AgentCategory = AgentCategory.Workflow,
  ) {}

  /**
   * Emit usage data to the progress view and attach detailed stats to the log.
   */
  public report(stats: ExtendedTokenUsageStats, runId?: string): void {
    const logStatistics = this.agentCategory === AgentCategory.Workflow;
    const usage = {
      inputTokens: stats.inputTokens + (stats.cacheCreationInputTokens ?? 0),
      outputTokens: stats.outputTokens,
      cost: stats.cost,
    };

    const groupId = this.logger.withCurrentGroup((id) => id);

    if (groupId) {
      bus.emit('updateGroupUsage', {
        stream: this.streamId,
        groupId,
        usage,
      });
      if (logStatistics) {
        this.logger.statistics(stats, groupId);
      }
      return;
    }

    if (runId) {
      bus.emit('updateStreamUsage', {
        stream: this.streamId,
        runId,
        usage,
      });
    }

    if (logStatistics) {
      this.logger.statistics(stats);
    }
  }
}
