import {
  emptyUsageStats,
  sumUsageStats,
  type StorageKey,
  type StreamTabId,
  type TokenUsageStats,
} from '@shared/schemas';
import { AgentLogger } from '@logger/AgentLogger';
import { mapToRecord } from '@progressView/persistence/serializationUtils';
import {
  TokenUsageStatsParsingSchema,
  isEmptyUsage,
} from '@progressView/persistence/streamTabSchemas';
import { getStreamTabStore } from '@progressView/persistence/StreamTabStore';

/**
 * Manages usage statistics collection with disk-backed persistence per stream tab.
 */
type RunUsageMap = Map<string, TokenUsageStats>;

export class UsageStatsManager {
  private items: Map<StreamTabId, RunUsageMap> = new Map();
  private loaded = false;
  private readonly logger: AgentLogger;

  constructor() {
    this.logger = new AgentLogger('UsageStatsManager');
  }

  /**
   * Accumulate usage statistics for a stream (adds deltas to existing values).
   * Returns the accumulated value to avoid race conditions from separate read.
   */
  async setRunUsage(
    stream: StreamTabId,
    storageKey: StorageKey,
    usage: TokenUsageStats,
  ): Promise<TokenUsageStats | undefined> {
    const delta = TokenUsageStatsParsingSchema.parse(usage);
    const current =
      this.items.get(stream) ?? new Map<string, TokenUsageStats>();

    if (isEmptyUsage(delta)) {
      return current.get(storageKey);
    }

    const existing = current.get(storageKey) ?? emptyUsageStats();
    const accumulated = sumUsageStats([existing, delta]);

    current.set(storageKey, accumulated);
    this.items.set(stream, current);

    await this.saveStream(stream);
    return accumulated;
  }

  /**
   * Get usage statistics for a stream (returns a copy of the map)
   */
  getRunUsage(stream: StreamTabId): RunUsageMap {
    return new Map(this.items.get(stream) ?? []);
  }

  /** Check if key exists */
  has(key: StreamTabId): boolean {
    return this.items.has(key);
  }

  /** Get all keys */
  keys(): StreamTabId[] {
    return [...this.items.keys()];
  }

  /** Get a value for the key */
  get(key: StreamTabId): RunUsageMap | undefined {
    return this.items.get(key);
  }

  /** Delete a stream's usage stats */
  async delete(stream: StreamTabId): Promise<void> {
    this.items.delete(stream);
    if (this.loaded) {
      const store = getStreamTabStore(stream);
      await store.writeUsageStats({});
    }
  }

  /** Clear all usage stats */
  async clear(): Promise<void> {
    const streams = [...this.items.keys()];
    this.items.clear();
    if (this.loaded) {
      await Promise.all(
        streams.map(async (stream) => {
          const store = getStreamTabStore(stream);
          await store.writeUsageStats({});
        }),
      );
    }
  }

  /** Load usage stats from disk-backed StreamTabStore */
  async load(streamIds: StreamTabId[]): Promise<void> {
    this.items.clear();

    await Promise.all(
      streamIds.map(async (streamId) => {
        const store = getStreamTabStore(streamId);
        const usageStats = await store.readUsageStats();
        if (usageStats && usageStats.size > 0) {
          this.items.set(streamId, usageStats);
        }
      }),
    );

    this.loaded = true;

    if (this.items.size > 0) {
      this.logger.debug(
        `Loaded usage statistics for ${this.items.size} streams`,
      );
    }
  }

  /** No-op: writes are immediate per-stream now */
  async flush(): Promise<void> {}

  // -- Per-stream persistence -----------------------------------------------

  private async saveStream(stream: StreamTabId): Promise<void> {
    if (!this.loaded) return;
    const data = this.items.get(stream);
    const store = getStreamTabStore(stream);
    await store.writeUsageStats(data ? mapToRecord(data) : {});
  }
}
