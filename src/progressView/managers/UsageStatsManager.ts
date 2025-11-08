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
    super(WorkspaceStateKey.USAGE_STATS, storage, ['texra.usageStats']);
    this.logger = new AgentLogger('UsageStatsManager');
  }

  /**
   * Update usage statistics for a stream
   */
  async updateStreamUsage(
    stream: StreamTabId,
    usage: TokenUsageStats,
  ): Promise<void> {
    await this.add(stream, this.sanitizeUsage(usage));
  }

  /**
   * Add usage to existing stream statistics
   */
  async addToStreamUsage(
    stream: StreamTabId,
    usage: TokenUsageStats,
  ): Promise<void> {
    const existing = this.get(stream);
    if (existing) {
      const current = this.sanitizeUsage(existing);
      const incoming = this.sanitizeUsage(usage);
      const updated: TokenUsageStats = {
        inputTokens: current.inputTokens + incoming.inputTokens,
        outputTokens: current.outputTokens + incoming.outputTokens,
        cost: current.cost + incoming.cost,
      };
      await this.add(stream, updated);
      return;
    }

    await this.add(stream, this.sanitizeUsage(usage));
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
  async deleteStream(stream: StreamTabId): Promise<void> {
    await this.delete(stream);
  }

  /**
   * Clear all usage statistics
   */
  async clear(): Promise<void> {
    await super.clear();
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
    if (!data || typeof data !== 'object') {
      return this.zeroUsage();
    }

    const candidate = data as Partial<TokenUsageStats>;
    return this.sanitizeUsage({
      inputTokens: candidate.inputTokens ?? NaN,
      outputTokens: candidate.outputTokens ?? NaN,
      cost: candidate.cost ?? NaN,
    });
  }

  private sanitizeUsage(usage: TokenUsageStats): TokenUsageStats {
    return {
      inputTokens: this.toSafeNumber(usage.inputTokens),
      outputTokens: this.toSafeNumber(usage.outputTokens),
      cost: this.toSafeNumber(usage.cost),
    };
  }

  private toSafeNumber(value: number): number {
    return Number.isFinite(value) ? value : 0;
  }

  private zeroUsage(): TokenUsageStats {
    return { inputTokens: 0, outputTokens: 0, cost: 0 };
  }
}
