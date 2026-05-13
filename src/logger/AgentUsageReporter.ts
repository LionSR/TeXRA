import { AgentCategory } from '@agent/core/AgentDataclass';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';

import type {
  ExtendedTokenUsageStats,
  StorageKey,
  StreamTabId,
} from '@shared/schemas';
import { AgentLogger } from './AgentLogger';

export class AgentUsageReporter {
  constructor(
    private readonly logger: AgentLogger,
    private readonly streamId: StreamTabId,
    private readonly agentCategory: AgentCategory,
    private readonly runtimeHost: AgentRuntimeHost,
  ) {}

  report(
    stats: ExtendedTokenUsageStats,
    storageKey: StorageKey,
    groupId?: string,
  ): void {
    this.runtimeHost.emit('updateStreamUsage', {
      streamId: this.streamId,
      storageKey,
      usage: stats,
    });

    if (this.agentCategory === AgentCategory.Workflow) {
      this.logger.statistics(stats, groupId ?? storageKey);
    }
  }
}
