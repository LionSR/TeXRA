// Local imports - progress view
// Local imports
import { PersistentMapManager } from '../persistence/PersistentMapManager';
import { StatePersistenceManager } from '../persistence/StatePersistenceManager';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Types
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { createChannelLogger, type ChannelLogger } from '@logger/logUtils';

/**
 * Manages usage statistics collection with persistence.
 * Handles tracking and updating token usage and costs for different streams.
 */
export class UsageStatsManager extends PersistentMapManager<
  StreamTabId,
  TokenUsageStats
> {
  private readonly logger: ChannelLogger;

  constructor(persistence: StatePersistenceManager) {
    super(persistence, WorkspaceStateKey.USAGE_STATS);
    this.logger = createChannelLogger('UsageStatsManager');
  }

  /**
   * Update usage statistics for a stream
   */
  updateStreamUsage(stream: StreamTabId, usage: TokenUsageStats): void {
    this.add(stream, { ...usage });
  }

  /**
   * Add usage to existing stream statistics
   */
  addToStreamUsage(stream: StreamTabId, usage: TokenUsageStats): void {
    const existing = this.get(stream) || {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };

    const updated: TokenUsageStats = {
      inputTokens: existing.inputTokens + (usage.inputTokens || 0),
      outputTokens: existing.outputTokens + (usage.outputTokens || 0),
      cost: existing.cost + (usage.cost || 0),
    };

    this.add(stream, updated);
  }

  /**
   * Get usage statistics for a stream
   */
  getStreamUsage(stream: StreamTabId): TokenUsageStats | undefined {
    return this.get(stream);
  }

  /**
   * Delete usage statistics for a stream
   */
  deleteStream(stream: StreamTabId): void {
    this.delete(stream);
  }

  /**
   * Clear all usage statistics
   */
  clear(): void {
    super.clear();
  }

  /**
   * Set all usage statistics (used during loading)
   */
  setAll(stats: Map<StreamTabId, TokenUsageStats>): void {
    super.setAll(stats);
  }

  /**
   * Calculate total usage across all streams
   */
  getTotalUsage(): TokenUsageStats {
    const total: TokenUsageStats = {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };

    for (const usage of this.items.values()) {
      total.inputTokens += usage.inputTokens || 0;
      total.outputTokens += usage.outputTokens || 0;
      total.cost += usage.cost || 0;
    }

    return total;
  }

  /**
   * Get streams with usage statistics
   */
  getStreamsWithUsage(): StreamTabId[] {
    return this.keys();
  }

  /**
   * Check if stream has usage statistics
   */
  hasUsage(stream: StreamTabId): boolean {
    return this.has(stream);
  }

  /**
   * Load usage statistics from persistence
   */
  async load(): Promise<void> {
    await super.load();
    if (this.items.size > 0) {
      this.logger.debug(
        `Loaded usage statistics for ${this.items.size} streams`,
      );
    }
  }

  /** Normalize loaded usage records */
  protected override async deserialize(
    data: unknown,
    _key: StreamTabId,
  ): Promise<TokenUsageStats> {
    const usage = (data as TokenUsageStats) || {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };
    return {
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      cost: usage.cost || 0,
    };
  }
}
