// Local imports - progress view
import {
  PersistentMapManager,
  type StateStorage,
} from '../persistence/PersistentMapManager';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Types
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';

/**
 * Manages usage statistics collection with persistence.
 * Handles tracking and updating token usage and costs for different streams.
 */
export class UsageStatsManager extends PersistentMapManager<
  StreamTabId,
  TokenUsageStats
> {
  private readonly logger: AgentLogger;

  constructor(storage?: StateStorage) {
    super(WorkspaceStateKey.USAGE_STATS, storage);
    this.logger = new AgentLogger('UsageStatsManager');
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
    const existing = this.get(stream);
    if (existing) {
      const updated: TokenUsageStats = {
        inputTokens: existing.inputTokens + usage.inputTokens,
        outputTokens: existing.outputTokens + usage.outputTokens,
        cost: existing.cost + usage.cost,
      };
      this.add(stream, updated);
      return;
    }

    this.add(stream, { ...usage });
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
    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;

    for (const usage of this.items.values()) {
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      cost += usage.cost;
    }

    return { inputTokens, outputTokens, cost };
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
    return data as TokenUsageStats;
  }
}
