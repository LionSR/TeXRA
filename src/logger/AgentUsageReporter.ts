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
   */
  public report(stats: ExtendedTokenUsageStats, storageKey: StorageKey): void {
    const logStatistics = this.agentCategory === AgentCategory.Workflow;

    // Pass through usage without modification
    const usage = {
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      cost: stats.cost,
    };

    // storageKey is THE single source of truth - no fallbacks, no round-trips
    bus.emit('updateStreamUsage', {
      stream: this.streamId,
      storageKey,
      usage,
    });

    // Log detailed statistics for display in the progress view
    // Use storageKey for logging context as well
    if (logStatistics) {
      this.logger.statistics(stats, storageKey);
    }
  }

  // Note: Context state is emitted by VSCodeTransport when CONTEXT_MANAGEMENT
  // log events are processed. This keeps context emission centralized in the
  // logging infrastructure rather than split between reporter and transport.
}
