import { AgentCategory } from '@agent/core/AgentDataclass';
import {
  getAgentRuntimeHost,
  type AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';

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
    private readonly agentCategory: AgentCategory = AgentCategory.Workflow,
    private readonly runtimeHost: AgentRuntimeHost = getAgentRuntimeHost(),
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
