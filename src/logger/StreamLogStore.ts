import { KVStore } from '@common/storage/KVStore';
import { WorkspaceStateKey } from '@common/state/stateKeys';
import type { MementoStorage } from '@progressView/persistence/PersistentMapManager';
import {
  PersistedStreamLogEntrySchema,
  StorageRecordSchema,
  STREAM_LOG_ENTRY_TYPES,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';

import {
  StreamLog,
  type StreamLogAppendInput,
  type StreamLogUpdatePatch,
} from './StreamLog';
import * as log from './logUtils';

const SAVE_DEBOUNCE_MS = 300;
const STREAM_LOGS_DIR = 'streamLogs';
const LOG_TAG = 'StreamLogStore';

type StreamLogListener = (streamId: StreamTabId) => void;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class StreamLogStore {
  private readonly logs = new Map<StreamTabId, StreamLog>();
  private readonly listeners = new Set<StreamLogListener>();
  private readonly dirtyStreamIds = new Set<StreamTabId>();
  private readonly kv = new KVStore(STREAM_LOGS_DIR, { compactJson: true });

  /**
   * Lightweight summary per stream (first/last timestamp). Populated at load
   * and refreshed on append/update. Survives `releaseEntries` so sidebar
   * metadata stays available for streams whose heavy entries have been evicted.
   */
  private readonly summaries = new Map<
    StreamTabId,
    { firstTimestamp?: number; lastTimestamp?: number }
  >();

  /** Deduplicates concurrent `ensureLoaded` calls for the same stream. */
  private readonly pendingLoads = new Map<StreamTabId, Promise<void>>();

  /**
   * Streams currently being flushed by `executeWrite`. `dirtyStreamIds` is
   * cleared before the async `kv.write` finishes, so we also have to treat
   * these as non-evictable — dropping the in-memory log mid-flight would
   * leave nothing to re-mark dirty if the write fails.
   */
  private readonly flushing = new Set<StreamTabId>();

  /**
   * Streams that went stale while still dirty, so `releaseEntries` deferred
   * the memory drop until the next save flush. Reads + new appends clear the
   * entry so a reactivated stream isn't evicted out from under the agent.
   */
  private readonly pendingRelease = new Set<StreamTabId>();

  /**
   * Streams whose rehydrate read from disk failed. While marked, saves skip
   * them so we never overwrite the authoritative disk copy with a fresh
   * empty-log-plus-new-appends that would drop persisted history.
   * Cleared when `ensureLoaded` eventually succeeds (subsequent `append`s
   * opportunistically retry the load).
   */
  private readonly loadFailed = new Set<StreamTabId>();

  /** Guards persistence — tests create store without calling load(). */
  private loaded = false;

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingResolve: (() => void) | null = null;
  private savePromise: Promise<void> | null = null;
  private inFlightWrite: Promise<void> | null = null;

  onChange(listener: StreamLogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(streamId: StreamTabId): StreamLog | undefined {
    return this.logs.get(streamId);
  }

  has(streamId: StreamTabId): boolean {
    // `summaries` is the authoritative registry of known streams and is
    // always a superset of `logs` (every entry we ever write to `logs`
    // also lands in `summaries`; eviction drops `logs` but keeps summary).
    return this.summaries.has(streamId);
  }

  keys(): StreamTabId[] {
    return [...this.summaries.keys()];
  }

  ensureStream(streamId: StreamTabId): void {
    // No-op if the stream is already known — either resident in `logs` or
    // released with metadata in `summaries`. Creating a fresh empty log here
    // for a released stream would shadow the on-disk copy from
    // `ensureLoaded`, leaving switches to that stream showing an empty view.
    if (this.logs.has(streamId) || this.summaries.has(streamId)) return;
    const logInstance = new StreamLog();
    this.logs.set(streamId, logInstance);
    this.summaries.set(streamId, {});
  }

  /**
   * Drop heavy entries from memory while keeping the on-disk copy authoritative.
   * If there are pending writes, queue the release so `executeWrite` can flush
   * first and actually evict afterwards; otherwise releases immediately.
   * Subsequent access must go through `ensureLoaded` to rehydrate.
   */
  releaseEntries(streamId: StreamTabId): void {
    const logInstance = this.logs.get(streamId);
    if (!logInstance) {
      // Can't drop what isn't resident — but if a rehydrate is in flight,
      // queue the intent so it runs once the load completes. Otherwise the
      // rapid in-flight → stale flip would finish the load into memory
      // with no subsequent eviction trigger.
      if (this.pendingLoads.has(streamId)) {
        this.pendingRelease.add(streamId);
      }
      return;
    }
    if (this.dirtyStreamIds.has(streamId) || this.flushing.has(streamId)) {
      this.pendingRelease.add(streamId);
      return;
    }
    this.pendingRelease.delete(streamId);
    this.refreshSummary(streamId, logInstance);
    this.logs.delete(streamId);
  }

  /**
   * Async reload entries from disk if they were released. No-op when already
   * resident or when the stream is unknown.
   */
  async ensureLoaded(streamId: StreamTabId): Promise<void> {
    // Reactivation cancels any deferred release so the fresh agent work
    // doesn't get evicted mid-run.
    this.pendingRelease.delete(streamId);
    // Normally skip when already resident. But after a failed rehydrate a
    // subsequent `append` may have populated a fresh empty log — we still
    // need to retry the disk read so the merge path can reunite it with
    // the persisted history before saves are re-enabled.
    if (this.logs.has(streamId) && !this.loadFailed.has(streamId)) return;
    if (!this.summaries.has(streamId)) return;
    const existing = this.pendingLoads.get(streamId);
    if (existing) return existing;
    const work = (async () => {
      try {
        const raw = await this.kv.read<unknown[]>(streamId);
        // If `delete` ran during the read, don't resurrect the stream.
        if (!this.summaries.has(streamId)) return;
        const diskEntries = this.parsePersistedEntries(raw);
        const live = this.logs.get(streamId);
        if (live && live.size > 0) {
          // A concurrent `append` populated `logs` during the disk read.
          // Merge disk (history) before the live appends so `save()` writes
          // the union instead of clobbering the authoritative disk copy
          // with just the new entries. StreamLog's constructor re-numbers
          // seqNos so the merged view stays contiguous.
          const merged = new StreamLog([...diskEntries, ...live.toJSON()]);
          this.logs.set(streamId, merged);
          this.refreshSummary(streamId, merged);
          this.markDirty(streamId);
          void this.save();
          this.notify(streamId);
        } else {
          const logInstance = new StreamLog(diskEntries);
          this.logs.set(streamId, logInstance);
          this.refreshSummary(streamId, logInstance);
          // A `releaseEntries` that arrived while the load was in flight gets
          // queued; honor it now (unless a reactivation cleared the intent).
          if (this.pendingRelease.has(streamId)) {
            this.pendingRelease.delete(streamId);
            if (!this.dirtyStreamIds.has(streamId)) {
              this.logs.delete(streamId);
            }
          }
        }
        // Load recovered — saves can persist this stream again. If a save
        // was deferred while the load was in flight (dirty stream re-queued
        // by executeWrite), flush it now so we don't wait for another
        // append to unblock it.
        this.loadFailed.delete(streamId);
        if (this.dirtyStreamIds.has(streamId)) void this.save();
      } catch {
        // Rehydrate failed. Mark so `executeWrite` skips this stream and
        // doesn't overwrite the on-disk history with whatever empty/partial
        // log the agent may now be appending to. `append` retries the load
        // in the background; once it succeeds the merge path runs.
        this.loadFailed.add(streamId);
        log.warn(LOG_TAG, `Failed to reload stream ${streamId} from disk`);
      }
    })();
    this.pendingLoads.set(streamId, work);
    try {
      await work;
    } finally {
      this.pendingLoads.delete(streamId);
    }
  }

  append(streamId: StreamTabId, entry: StreamLogAppendInput): StreamLogEntry {
    // New writes mean the stream is live again — cancel any deferred release.
    this.pendingRelease.delete(streamId);
    // If a previous rehydrate errored, retry in the background so the
    // eventual merge can combine disk history with these new entries
    // before we're allowed to save. `ensureLoaded` dedupes via
    // `pendingLoads` so repeated appends don't spam overlapping reads.
    if (this.loadFailed.has(streamId)) void this.ensureLoaded(streamId);
    const logInstance = this.getOrCreate(streamId);
    const appended = logInstance.append(entry);
    this.refreshSummary(streamId, logInstance);
    this.markDirty(streamId);
    void this.save();
    this.notify(streamId);
    return appended;
  }

  update(
    streamId: StreamTabId,
    id: string,
    patch: StreamLogUpdatePatch,
  ): StreamLogEntry | undefined {
    const logInstance = this.logs.get(streamId);
    if (!logInstance) return undefined;

    const updated = logInstance.update(id, patch);
    if (!updated) return undefined;

    this.refreshSummary(streamId, logInstance);
    this.markDirty(streamId);
    void this.save();
    this.notify(streamId);
    return updated;
  }

  clearDirtyUpdates(streamId: StreamTabId): void {
    this.logs.get(streamId)?.clearDirtyUpdates();
  }

  getFirstTimestamp(streamId: StreamTabId): number | undefined {
    return (
      this.logs.get(streamId)?.firstTimestamp ??
      this.summaries.get(streamId)?.firstTimestamp
    );
  }

  getLastTimestamp(streamId: StreamTabId): number | undefined {
    return (
      this.logs.get(streamId)?.lastTimestamp ??
      this.summaries.get(streamId)?.lastTimestamp
    );
  }

  async delete(streamId: StreamTabId): Promise<void> {
    this.logs.delete(streamId);
    this.summaries.delete(streamId);
    this.dirtyStreamIds.delete(streamId);
    this.pendingRelease.delete(streamId);
    this.flushing.delete(streamId);
    this.loadFailed.delete(streamId);
    this.pendingLoads.delete(streamId);
    if (!this.loaded) return;

    this.cancelPendingSave();
    log.info(LOG_TAG, `Deleting stream: ${streamId}`);
    await this.kv.delete(streamId);
  }

  async clear(): Promise<void> {
    const count = this.logs.size;
    this.logs.clear();
    this.summaries.clear();
    this.dirtyStreamIds.clear();
    this.pendingRelease.clear();
    this.flushing.clear();
    this.loadFailed.clear();
    this.pendingLoads.clear();
    if (!this.loaded) return;

    this.cancelPendingSave();
    log.info(LOG_TAG, `Clearing all ${count} streams`);
    await this.kv.deleteDir();
  }

  endRunningGroups(now: number = Date.now()): StreamTabId[] {
    const affected: StreamTabId[] = [];
    for (const [streamId, logInstance] of this.logs.entries()) {
      let updatedAny = false;
      for (const entry of logInstance.getRange(0, logInstance.head)) {
        if (entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_START) continue;
        const existingData = isObject(entry.data) ? entry.data : {};
        const status =
          typeof existingData.status === 'string'
            ? existingData.status
            : 'running';
        if (status !== 'running') continue;

        updatedAny ||= !!logInstance.update(entry.id, {
          type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
          data: { ...existingData, status: 'error', endTime: now },
        });
      }

      if (updatedAny) {
        affected.push(streamId);
        this.markDirty(streamId);
        this.notify(streamId);
      }
    }

    if (affected.length > 0) {
      void this.save();
    }

    return affected;
  }

  /**
   * Load stream logs from disk. If no on-disk data exists and a memento
   * source is provided, performs a one-time migration from VS Code memento.
   */
  async load(migrationSource?: MementoStorage): Promise<void> {
    this.logs.clear();
    this.summaries.clear();
    this.dirtyStreamIds.clear();
    this.pendingRelease.clear();
    this.flushing.clear();
    this.loadFailed.clear();
    this.pendingLoads.clear();

    // 1. Scan directory — filenames decode back to stream IDs
    const streamIds = await this.kv.listKeys();

    if (streamIds.length > 0) {
      const results = await Promise.all(
        streamIds.map(async (streamId) => {
          try {
            const raw = await this.kv.read<unknown[]>(streamId);
            return [streamId, this.parsePersistedEntries(raw)] as const;
          } catch {
            log.warn(LOG_TAG, `Skipping corrupt stream log: ${streamId}`);
            return [streamId, [] as StreamLogEntry[]] as const;
          }
        }),
      );

      const sortedResults = [...results].sort(
        ([aStreamId, aEntries], [bStreamId, bEntries]) =>
          (aEntries[0]?.timestamp ?? Number.POSITIVE_INFINITY) -
            (bEntries[0]?.timestamp ?? Number.POSITIVE_INFINITY) ||
          aStreamId.localeCompare(bStreamId),
      );

      let totalEntries = 0;
      for (const [streamId, entries] of sortedResults) {
        if (entries.length > 0) {
          const logInstance = new StreamLog(entries);
          this.logs.set(streamId as StreamTabId, logInstance);
          this.refreshSummary(streamId as StreamTabId, logInstance);
          totalEntries += entries.length;
        }
      }

      log.info(
        LOG_TAG,
        `Loaded ${this.logs.size} streams, ${totalEntries} entries (file-backed)`,
      );
      this.loaded = true;
      return;
    }

    // 2. No on-disk data — try one-time migration from memento
    if (migrationSource) {
      await this.migrateFromMemento(migrationSource);
    }

    this.loaded = true;
  }

  async save(): Promise<void> {
    if (!this.loaded) return;

    if (this.saveTimer !== null) clearTimeout(this.saveTimer);

    if (!this.savePromise || this.pendingResolve === null) {
      this.savePromise = new Promise<void>((resolve) => {
        this.pendingResolve = resolve;
      });
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      this.executeWrite(resolve);
    }, SAVE_DEBOUNCE_MS);

    return this.savePromise;
  }

  async flush(): Promise<void> {
    if (!this.loaded) return;

    // Drain iteratively: executeWrite may re-queue streams that are still
    // rehydrating (`pendingLoads`) or whose prior load failed. Wait for
    // those to resolve and then re-run the save, so shutdown doesn't lose
    // appends that landed on a resumed stream. Bound the loop by the set
    // of streams that could still make progress — if the only dirty
    // entries are persistently `loadFailed`, we can't persist them.
    // Cap the write retries so a persistent write error (disk full, perm
    // denied) doesn't hang shutdown forever — `executeWrite`'s catch
    // re-marks failed streams dirty, which would otherwise spin.
    const MAX_WRITE_RETRIES = 3;
    let writeAttempts = 0;
    while (true) {
      if (this.saveTimer !== null) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        const resolve = this.pendingResolve;
        this.pendingResolve = null;
        await this.executeWrite(resolve);
        writeAttempts++;
      } else if (this.inFlightWrite) {
        await this.inFlightWrite;
      } else if (this.pendingLoads.size > 0) {
        await Promise.allSettled([...this.pendingLoads.values()]);
      } else {
        // No in-flight work. Decide whether anything deferred can still
        // be persisted in another save cycle.
        const canRetry = [...this.dirtyStreamIds].some(
          (id) => !this.loadFailed.has(id),
        );
        if (!canRetry) return;
        if (writeAttempts >= MAX_WRITE_RETRIES) {
          log.warn(
            LOG_TAG,
            `flush() gave up after ${MAX_WRITE_RETRIES} retries; ` +
              `${this.dirtyStreamIds.size} stream(s) still dirty`,
          );
          return;
        }
        await this.executeWrite(null);
        writeAttempts++;
      }
    }
  }

  private getOrCreate(streamId: StreamTabId): StreamLog {
    let logInstance = this.logs.get(streamId);
    if (!logInstance) {
      logInstance = new StreamLog();
      this.logs.set(streamId, logInstance);
      if (!this.summaries.has(streamId)) this.summaries.set(streamId, {});
    }
    return logInstance;
  }

  private refreshSummary(streamId: StreamTabId, logInstance: StreamLog): void {
    // Mutate in place — no observer watches summary object identity, and
    // this runs on the per-append hot path (~200/s during streaming), so
    // avoiding the per-call allocation is worthwhile.
    const existing = this.summaries.get(streamId);
    if (existing) {
      existing.firstTimestamp = logInstance.firstTimestamp;
      existing.lastTimestamp = logInstance.lastTimestamp;
    } else {
      this.summaries.set(streamId, {
        firstTimestamp: logInstance.firstTimestamp,
        lastTimestamp: logInstance.lastTimestamp,
      });
    }
  }

  private markDirty(streamId: StreamTabId): void {
    this.dirtyStreamIds.add(streamId);
  }

  private notify(streamId: StreamTabId): void {
    for (const listener of this.listeners) {
      listener(streamId);
    }
  }

  private cancelPendingSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.pendingResolve = null;
    this.savePromise = null;
  }

  private parsePersistedEntries(rawEntries: unknown): StreamLogEntry[] {
    if (!Array.isArray(rawEntries)) return [];
    return rawEntries.flatMap((raw) => {
      const result = PersistedStreamLogEntrySchema.safeParse(raw);
      return result.success ? [result.data] : [];
    });
  }

  /**
   * One-time migration from VS Code memento to file-backed storage.
   * Handles monolithic STREAM_LOGS and legacy STREAM_TABS formats.
   */
  private async migrateFromMemento(storage: MementoStorage): Promise<void> {
    if (
      !this.loadFromMementoRecord(
        storage,
        WorkspaceStateKey.STREAM_LOGS,
        'monolithic',
      )
    ) {
      this.loadFromMementoRecord(
        storage,
        WorkspaceStateKey.STREAM_TABS,
        'legacy STREAM_TABS',
      );
    }

    if (this.logs.size === 0) return;

    await Promise.all(
      [...this.logs].map(([streamId, logInstance]) =>
        this.kv.write(streamId, logInstance.toJSON()),
      ),
    );

    log.info(
      LOG_TAG,
      `Migrated ${this.logs.size} streams to file-backed storage`,
    );

    // Clear memento keys after successful migration
    await Promise.all([
      storage.update(WorkspaceStateKey.STREAM_LOGS, undefined),
      storage.update(WorkspaceStateKey.STREAM_TABS, undefined),
    ]);

    this.dirtyStreamIds.clear();
  }

  private loadFromMementoRecord(
    storage: MementoStorage,
    key: WorkspaceStateKey,
    label: string,
  ): boolean {
    const raw = storage.get(key);
    const record = StorageRecordSchema.catch({}).parse(raw);
    if (Object.keys(record).length === 0) return false;

    let totalEntries = 0;
    for (const [streamId, rawEntries] of Object.entries(record)) {
      const entries = this.parsePersistedEntries(rawEntries);
      if (entries.length > 0) {
        const logInstance = new StreamLog(entries);
        this.logs.set(streamId as StreamTabId, logInstance);
        this.refreshSummary(streamId as StreamTabId, logInstance);
        totalEntries += entries.length;
      }
    }

    log.info(
      LOG_TAG,
      `Loaded ${this.logs.size} streams, ${totalEntries} entries from memento (${label}, migrating)`,
    );
    return this.logs.size > 0;
  }

  private executeWrite(resolve: (() => void) | null): Promise<void> {
    if (!this.loaded) {
      resolve?.();
      return Promise.resolve();
    }

    // Skip streams whose rehydrate is pending or errored — writing now
    // would clobber the authoritative on-disk history with a fresh
    // empty-plus-new-appends log before `ensureLoaded` merges disk entries
    // back in. Keep them dirty so the next save retries after the load
    // resolves.
    const allDirty = [...this.dirtyStreamIds];
    this.dirtyStreamIds.clear();
    const dirtyIds: StreamTabId[] = [];
    for (const streamId of allDirty) {
      if (this.loadFailed.has(streamId) || this.pendingLoads.has(streamId)) {
        this.dirtyStreamIds.add(streamId);
      } else {
        dirtyIds.push(streamId);
      }
    }

    if (dirtyIds.length === 0) {
      resolve?.();
      return Promise.resolve();
    }

    log.debug(LOG_TAG, `Writing ${dirtyIds.length} dirty stream(s)`);

    // Mark these as mid-flush so `releaseEntries` defers — we need the
    // in-memory copy preserved until the write resolves, otherwise a failed
    // write can't re-mark the stream dirty (there'd be no log entries left).
    for (const streamId of dirtyIds) this.flushing.add(streamId);

    // `Promise.allSettled` keeps per-stream outcomes so a single failed
    // write doesn't poison the drain for the other streams in the batch —
    // `pendingRelease` entries for streams that wrote fine still get evicted.
    const writePromise = Promise.allSettled(
      dirtyIds.map((streamId) => {
        const logInstance = this.logs.get(streamId);
        return logInstance
          ? this.kv.write(streamId, logInstance.toPersistedEntries())
          : Promise.resolve();
      }),
    )
      .then((results) => {
        // Failed writes re-mark their streams dirty so the next save
        // retries. Successful streams are now persisted and safe to evict
        // (drainPendingReleases' dirtyStreamIds check excludes failed ones).
        results.forEach((result, i) => {
          if (result.status === 'rejected') {
            const streamId = dirtyIds[i];
            if (this.logs.has(streamId)) this.dirtyStreamIds.add(streamId);
          }
        });
      })
      .finally(() => {
        for (const streamId of dirtyIds) this.flushing.delete(streamId);
        if (this.inFlightWrite === writePromise) {
          this.inFlightWrite = null;
          if (!this.pendingResolve) {
            this.savePromise = null;
          }
        }
        this.drainPendingReleases();
        resolve?.();
      });

    this.inFlightWrite = writePromise;
    return writePromise;
  }

  /**
   * Evict streams whose release was deferred while they were dirty. Called
   * after every write flush. Any reactivation (append / ensureLoaded /
   * delete) will have cleared the pending entry, so only streams that stayed
   * idle and clean through the flush are actually released here.
   */
  private drainPendingReleases(): void {
    if (this.pendingRelease.size === 0) return;
    for (const streamId of [...this.pendingRelease]) {
      if (this.dirtyStreamIds.has(streamId)) continue;
      this.pendingRelease.delete(streamId);
      const logInstance = this.logs.get(streamId);
      if (!logInstance) continue;
      this.refreshSummary(streamId, logInstance);
      this.logs.delete(streamId);
    }
  }
}

let defaultStore: StreamLogStore | undefined;

export function getDefaultStreamLogStore(): StreamLogStore {
  defaultStore ??= new StreamLogStore();
  return defaultStore;
}

export function setDefaultStreamLogStore(store: StreamLogStore): void {
  defaultStore = store;
}
