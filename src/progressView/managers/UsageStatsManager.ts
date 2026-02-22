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
 *
 * Disk writes happen per-stream on mutation. Disk deletion is owned by
 * ProgressViewState (via store.clear() / deleteAllStreamData()).
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

  /** Get usage statistics for a stream (returns a copy of the map) */
  getRunUsage(stream: StreamTabId): RunUsageMap {
    return new Map(this.items.get(stream) ?? []);
  }

  /** Remove a stream from in-memory state. Disk cleanup owned by caller. */
  evict(stream: StreamTabId): void {
    this.items.delete(stream);
  }

  /** Clear all in-memory state. Disk cleanup owned by caller. */
  evictAll(): void {
    this.items.clear();
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

  // -- Per-stream persistence -----------------------------------------------

  private async saveStream(stream: StreamTabId): Promise<void> {
    if (!this.loaded) return;
    const data = this.items.get(stream);
    const store = getStreamTabStore(stream);
    await store.writeUsageStats(data ? mapToRecord(data) : {});
  }
}
