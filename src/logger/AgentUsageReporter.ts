import type { AgentTrace } from '@agent/trace';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';

import type {
  ExtendedTokenUsageStats,
  StorageKey,
  StreamTabId,
} from '@shared/schemas';

export class AgentUsageReporter {
  constructor(
    private readonly logger: AgentTrace,
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
