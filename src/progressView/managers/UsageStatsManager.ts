// Local imports
import { StatePersistenceManager } from '../persistence/StatePersistenceManager';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';

// Types
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

/**
 * Manages usage statistics collection with persistence.
 * Handles tracking and updating token usage and costs for different streams.
 */
export class UsageStatsManager {
  private _usageStats: Map<StreamTabId, TokenUsageStats> = new Map();
  private readonly logger: AgentLogger;

  constructor(private persistence: StatePersistenceManager) {
    this.logger = new AgentLogger('UsageStatsManager');
  }

  /**
   * Update usage statistics for a stream
   */
  updateStreamUsage(stream: StreamTabId, usage: TokenUsageStats): void {
    this._usageStats.set(stream, { ...usage });
    this.save();
  }

  /**
   * Add usage to existing stream statistics
   */
  addToStreamUsage(stream: StreamTabId, usage: TokenUsageStats): void {
    const existing = this._usageStats.get(stream) || {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };

    const updated: TokenUsageStats = {
      inputTokens: existing.inputTokens + (usage.inputTokens || 0),
      outputTokens: existing.outputTokens + (usage.outputTokens || 0),
      cost: existing.cost + (usage.cost || 0),
    };

    this._usageStats.set(stream, updated);
    this.save();
  }

  /**
   * Get usage statistics for a stream
   */
  getStreamUsage(stream: StreamTabId): TokenUsageStats | undefined {
    return this._usageStats.get(stream);
  }

  /**
   * Get all usage statistics
   */
  getAll(): Map<StreamTabId, TokenUsageStats> {
    return new Map(this._usageStats);
  }

  /**
   * Delete usage statistics for a stream
   */
  deleteStream(stream: StreamTabId): void {
    this._usageStats.delete(stream);
    this.save();
  }

  /**
   * Clear all usage statistics
   */
  clear(): void {
    this._usageStats.clear();
    this.save();
  }

  /**
   * Set all usage statistics (used during loading)
   */
  setAll(stats: Map<StreamTabId, TokenUsageStats>): void {
    this._usageStats = new Map(stats);
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

    for (const usage of this._usageStats.values()) {
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
    return Array.from(this._usageStats.keys());
  }

  /**
   * Check if stream has usage statistics
   */
  hasUsage(stream: StreamTabId): boolean {
    return this._usageStats.has(stream);
  }

  /**
   * Load usage statistics from persistence
   */
  async load(): Promise<void> {
    const savedUsage = await this.persistence.load<{
      [key: string]: {
        inputTokens: number;
        outputTokens: number;
        cost: number;
      };
    }>(WorkspaceStateKey.USAGE_STATS, {});

    if (savedUsage && Object.keys(savedUsage).length > 0) {
      const processedUsage = new Map<StreamTabId, TokenUsageStats>();

      for (const [stream, usage] of Object.entries(savedUsage)) {
        // Ensure all required fields are present
        const normalizedUsage: TokenUsageStats = {
          inputTokens: usage.inputTokens || 0,
          outputTokens: usage.outputTokens || 0,
          cost: usage.cost || 0,
        };

        processedUsage.set(stream, normalizedUsage);
      }

      this._usageStats = processedUsage;
      this.logger.debug(
        `Loaded usage statistics for ${this._usageStats.size} streams`,
      );
    } else {
      this._usageStats.clear();
    }
  }

  /**
   * Save usage statistics to persistence
   */
  save(): void {
    const usageObj = Object.fromEntries(this._usageStats.entries());
    this.persistence.save(WorkspaceStateKey.USAGE_STATS, usageObj);
  }
}
