// Local imports - agent types
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { ExtendedTokenUsageStats } from '@agent/types/UsageTypes';
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
  ) {}

  /**
   * Emit usage data to the progress view and attach detailed stats to the log.
   */
  public report(stats: ExtendedTokenUsageStats): void {
    const groupId = this.logger.getActiveGroupId();

    if (groupId) {
      bus.emit('updateGroupUsage', {
        stream: this.streamId,
        groupId,
        usage: {
          inputTokens: stats.inputTokens + (stats.cacheCreationInputTokens ?? 0),
          outputTokens: stats.outputTokens,
          cost: stats.cost,
        },
      });
    }

    this.logger.statistics(stats);
  }
}
