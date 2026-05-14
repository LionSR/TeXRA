import { applyTurnAccounting } from '@agent/odyssey';
import { AgentLogger } from '@logger/AgentLogger';
import { mapToRecord } from '@progressView/persistence/serializationUtils';
import {
  TokenUsageStatsParsingSchema,
  isEmptyUsage,
} from '@progressView/persistence/streamTabSchemas';
import {
  getStreamTabStore,
  mapStreamTabStorage,
} from '@progressView/persistence/StreamTabStore';
import {
  emptyUsageStats,
  sumUsageStats,
  type StorageKey,
  type StreamTabId,
  type TokenUsageStats,
} from '@shared/schemas';

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
  private readonly pendingWrites = new Map<StreamTabId, Promise<void>>();

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

    this.saveStream(stream);

    // Best-effort: accumulate per-Odyssey accounting at the same point usage
    // is recorded. No-op when the stream has no Odyssey or it's in a terminal
    // state. Imported lazily to avoid coupling usage tracking to the
    // optional feature.
    void applyTurnAccounting(stream, {
      tokens: (delta.inputTokens ?? 0) + (delta.outputTokens ?? 0),
      durationMs: 0,
    }).catch(() => {
      /* accounting is informational only; never fail usage on this */
    });

    return accumulated;
  }

  /** Get usage statistics for a stream (returns a copy of the map) */
  getRunUsage(stream: StreamTabId): RunUsageMap {
    return new Map(this.items.get(stream) ?? []);
  }

  /** Remove a stream from in-memory state. Disk cleanup owned by caller. */
  evict(stream: StreamTabId): void {
    this.items.delete(stream);
    this.pendingWrites.delete(stream);
  }

  /** Clear all in-memory state. Disk cleanup owned by caller. */
  evictAll(): void {
    this.items.clear();
    this.pendingWrites.clear();
  }

  /** Load usage stats from disk-backed StreamTabStore */
  async load(streamIds: StreamTabId[]): Promise<void> {
    this.items.clear();

    await mapStreamTabStorage(streamIds, async (streamId) => {
      const store = getStreamTabStore(streamId);
      const usageStats = await store.readUsageStats();
      if (usageStats?.size) {
        this.items.set(streamId, usageStats);
      }
    });

    this.loaded = true;

    if (this.items.size > 0) {
      this.logger.debug(
        `Loaded usage statistics for ${this.items.size} streams`,
      );
    }
  }

  /** Await all pending disk writes. */
  async flush(): Promise<void> {
    await Promise.all(this.pendingWrites.values());
  }

  // -- Per-stream persistence -----------------------------------------------

  private saveStream(stream: StreamTabId): void {
    if (!this.loaded) return;
    const prev = this.pendingWrites.get(stream) ?? Promise.resolve();
    const next = prev.then(() => {
      if (!this.pendingWrites.has(stream)) return;
      const data = this.items.get(stream);
      const store = getStreamTabStore(stream);
      return store.writeUsageStats(data ? mapToRecord(data) : {});
    });
    this.pendingWrites.set(
      stream,
      next.catch(() => {}),
    );
  }
}
