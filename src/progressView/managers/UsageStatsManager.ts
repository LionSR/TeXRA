// Local imports - progress view
// Local imports
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Types
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import {
  WorkspaceStateKey,
  type StateManager,
} from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';

/**
 * Manages usage statistics collection with persistence.
 * Handles tracking and updating token usage and costs for different streams.
 */
export class UsageStatsManager {
  private readonly logger: AgentLogger;
  private readonly store: StateManager;
  private readonly items = new Map<StreamTabId, TokenUsageStats>();

  constructor(store: StateManager) {
    this.store = store;
    this.logger = new AgentLogger('UsageStatsManager');
  }

  /**
   * Update usage statistics for a stream
   */
  updateStreamUsage(stream: StreamTabId, usage: TokenUsageStats): void {
    this.items.set(stream, { ...usage });
    this.persist();
  }

  /**
   * Add usage to existing stream statistics
   */
  addToStreamUsage(stream: StreamTabId, usage: TokenUsageStats): void {
    const existing = this.items.get(stream);
    const updated: TokenUsageStats = existing
      ? {
          inputTokens: existing.inputTokens + usage.inputTokens,
          outputTokens: existing.outputTokens + usage.outputTokens,
          cost: existing.cost + usage.cost,
        }
      : { ...usage };

    this.items.set(stream, updated);
    this.persist();
  }

  /**
   * Get usage statistics for a stream
   */
  getStreamUsage(stream: StreamTabId): TokenUsageStats | undefined {
    return this.items.get(stream);
  }

  /**
   * Delete usage statistics for a stream
   */
  deleteStream(stream: StreamTabId): void {
    if (this.items.delete(stream)) {
      this.persist();
    }
  }

  /**
   * Clear all usage statistics
   */
  clear(): void {
    if (this.items.size === 0) {
      return;
    }
    this.items.clear();
    this.persist();
  }

  /**
   * Set all usage statistics (used during loading)
   */
  setAll(stats: Map<StreamTabId, TokenUsageStats>): void {
    this.items.clear();
    for (const [stream, usage] of stats.entries()) {
      this.items.set(stream, { ...usage });
    }
    this.persist();
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
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
      total.cost += usage.cost;
    }

    return total;
  }

  /**
   * Get streams with usage statistics
   */
  getStreamsWithUsage(): StreamTabId[] {
    return Array.from(this.items.keys());
  }

  /**
   * Check if stream has usage statistics
   */
  hasUsage(stream: StreamTabId): boolean {
    return this.items.has(stream);
  }

  /**
   * Load usage statistics from persistence
   */
  async load(): Promise<void> {
    const saved = this.store.get<Record<string, TokenUsageStats>>(
      WorkspaceStateKey.USAGE_STATS,
      {},
    );

    this.items.clear();
    for (const [stream, usage] of Object.entries(saved ?? {})) {
      this.items.set(stream as StreamTabId, { ...usage });
    }

    if (this.items.size > 0) {
      this.logger.debug(
        `Loaded usage statistics for ${this.items.size} streams`,
      );
    }
  }

  get(stream: StreamTabId): TokenUsageStats | undefined {
    return this.items.get(stream);
  }

  private persist(): void {
    const serialized = Object.fromEntries(
      Array.from(this.items.entries(), ([stream, usage]) => [
        stream,
        { ...usage },
      ]),
    );
    void this.store.update(WorkspaceStateKey.USAGE_STATS, serialized);
  }
}
