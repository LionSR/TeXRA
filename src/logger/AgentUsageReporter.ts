import { AgentCategory } from '@agent/core/AgentDataclass';
import { bus } from '@eventBus/ProgressEventBus';

import { AgentLogger } from './AgentLogger';
import type {
  ExtendedTokenUsageStats,
  StorageKey,
  StreamTabId,
} from '@shared/schemas';

/**
 * Bridges usage statistics from model handlers into log transport events.
 * Usage data flows through without modification - cost and token counts
 * are already computed upstream in the model handlers.
 */
export class AgentUsageReporter {
  constructor(
    private readonly logger: AgentLogger,
    private readonly streamId: StreamTabId,
    private readonly agentCategory: AgentCategory = AgentCategory.Workflow,
  ) {}

  report(
    stats: ExtendedTokenUsageStats,
    storageKey: StorageKey,
    groupId?: string,
  ): void {
    bus.emit('updateStreamUsage', {
      streamId: this.streamId,
      storageKey,
      usage: stats,
    });

    if (this.agentCategory === AgentCategory.Workflow) {
      this.logger.statistics(stats, groupId ?? storageKey);
    }
  }
}
