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
 *
 * ## Single Source of Truth
 * The storageKey parameter is THE authoritative key for storage operations.
 * It is computed once at execution start:
 * - Workflow agents: storageKey = task group ID
 * - Tool-use agents: storageKey = executionId
 *
 * This class does NOT query the logger for group IDs - it trusts the
 * passed storageKey as the single source of truth.
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
   * @param stats - Token usage statistics to report
   * @param storageKey - THE key for storage (from context.storageKey) - REQUIRED
   * @param groupId - Optional group ID for statistics logging. If provided, statistics
   *                  are logged with this group ID (e.g., round stage ID like r0, r1).
   *                  If not provided, uses storageKey as the group ID.
   */
  public report(
    stats: ExtendedTokenUsageStats,
    storageKey: StorageKey,
    groupId?: string,
  ): void {
    bus.emit('updateStreamUsage', {
      streamId: this.streamId,
      storageKey,
      usage: {
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        cost: stats.cost,
        cacheReadInputTokens: stats.cacheReadInputTokens,
        cacheCreationInputTokens: stats.cacheCreationInputTokens,
      },
    });

    if (this.agentCategory === AgentCategory.Workflow) {
      // Use groupId if provided (round-specific), otherwise fall back to storageKey
      this.logger.statistics(stats, groupId ?? storageKey);
    }
  }

  // Note: Context state is emitted by VSCodeTransport when CONTEXT_MANAGEMENT
  // log events are processed. This keeps context emission centralized in the
  // logging infrastructure rather than split between reporter and transport.
}
