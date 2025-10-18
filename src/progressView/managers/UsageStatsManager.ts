// Local imports - progress view
// Local imports
import { PersistentMapManager } from '../persistence/PersistentMapManager';
import { StatePersistenceManager } from '../persistence/StatePersistenceManager';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Types
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';

/**
 * Manages usage statistics collection with persistence.
 * Handles tracking and updating token usage and costs for different sessions within streams.
 */
export class UsageStatsManager extends PersistentMapManager<
  StreamTabId,
  { [groupId: string]: TokenUsageStats }
> {
  private readonly logger: AgentLogger;

  constructor(persistence: StatePersistenceManager) {
    super(persistence, WorkspaceStateKey.USAGE_STATS);
    this.logger = new AgentLogger('UsageStatsManager');
  }

  /**
   * Update usage statistics for a specific session within a stream
   */
  updateSessionUsage(
    stream: StreamTabId,
    groupId: string,
    usage: TokenUsageStats,
  ): void {
    const existing = this.get(stream) || {};
    existing[groupId] = { ...usage };
    this.add(stream, existing);
  }

  /**
   * Add usage to existing session statistics
   */
  addToSessionUsage(
    stream: StreamTabId,
    groupId: string,
    usage: TokenUsageStats,
  ): void {
    const streamData = this.get(stream) || {};
    const existing = streamData[groupId] || {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };

    streamData[groupId] = {
      inputTokens: existing.inputTokens + (usage.inputTokens || 0),
      outputTokens: existing.outputTokens + (usage.outputTokens || 0),
      cost: existing.cost + (usage.cost || 0),
    };

    this.add(stream, streamData);
  }

  /**
   * Get usage statistics for a specific session
   */
  getSessionUsage(
    stream: StreamTabId,
    groupId: string,
  ): TokenUsageStats | undefined {
    const streamData = this.get(stream);
    return streamData?.[groupId];
  }

  /**
   * Get total usage statistics for a stream (sum of all sessions)
   */
  getStreamUsage(stream: StreamTabId): TokenUsageStats | undefined {
    const streamData = this.get(stream);
    if (!streamData) {
      return undefined;
    }

    const total: TokenUsageStats = {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };

    for (const sessionUsage of Object.values(streamData)) {
      total.inputTokens += sessionUsage.inputTokens || 0;
      total.outputTokens += sessionUsage.outputTokens || 0;
      total.cost += sessionUsage.cost || 0;
    }

    return total;
  }

  /**
   * Delete usage statistics for a specific session
   */
  deleteSessionUsage(stream: StreamTabId, groupId: string): void {
    const streamData = this.get(stream);
    if (streamData && streamData[groupId]) {
      delete streamData[groupId];
      this.add(stream, streamData);
    }
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
  setAll(
    stats: Map<StreamTabId, { [groupId: string]: TokenUsageStats }>,
  ): void {
    super.setAll(stats);
  }

  /**
   * Calculate total usage across all streams and sessions
   */
  getTotalUsage(): TokenUsageStats {
    const total: TokenUsageStats = {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };

    for (const streamData of this.items.values()) {
      for (const usage of Object.values(streamData)) {
        total.inputTokens += usage.inputTokens || 0;
        total.outputTokens += usage.outputTokens || 0;
        total.cost += usage.cost || 0;
      }
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

  /** Normalize loaded usage records with migration support */
  protected override async deserialize(
    data: unknown,
    _key: StreamTabId,
  ): Promise<{ [groupId: string]: TokenUsageStats }> {
    if (!data || typeof data !== 'object') {
      return {};
    }

    const obj = data as any;

    // Check if this is old format (direct TokenUsageStats) or new format (grouped by sessionId)
    // Old format has inputTokens/outputTokens/cost at top level
    // New format has these inside groupId objects
    if ('inputTokens' in obj || 'outputTokens' in obj || 'cost' in obj) {
      // Old format: migrate to __MIGRATION__ session
      const usage: TokenUsageStats = {
        inputTokens: obj.inputTokens || 0,
        outputTokens: obj.outputTokens || 0,
        cost: obj.cost || 0,
      };
      return { __MIGRATION__: usage };
    }

    // New format: validate and normalize each session's usage
    const result: { [groupId: string]: TokenUsageStats } = {};
    for (const [groupId, sessionData] of Object.entries(obj)) {
      const usage = (sessionData as any) || {};
      result[groupId] = {
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        cost: usage.cost || 0,
      };
    }

    return result;
  }
}
