import { KVStore } from '@common/storage';
import { WorkspaceStateKey } from '@common/state';
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
  private readonly kv = new KVStore(STREAM_LOGS_DIR);

  /**
   * Lightweight summary per stream (first/last timestamp). Populated at load
   * and refreshed on append/update. Survives `releaseEntries` so sidebar
   * sorting keeps working for streams whose heavy entries have been evicted.
   */
  private readonly summaries = new Map<
    StreamTabId,
    { firstTimestamp?: number; lastTimestamp?: number }
  >();

  /** Deduplicates concurrent `ensureLoaded` calls for the same stream. */
  private readonly pendingLoads = new Map<StreamTabId, Promise<void>>();

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
    return this.logs.has(streamId) || this.summaries.has(streamId);
  }

  keys(): StreamTabId[] {
    // Union of loaded + summary-only streams; Set dedupes.
    return [...new Set([...this.logs.keys(), ...this.summaries.keys()])];
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
   * Skips streams with pending writes so `save()` can flush first. Subsequent
   * access must go through `ensureLoaded` to rehydrate.
   */
  releaseEntries(streamId: StreamTabId): void {
    const logInstance = this.logs.get(streamId);
    if (!logInstance) return;
    if (this.dirtyStreamIds.has(streamId)) return;
    this.refreshSummary(streamId, logInstance);
    this.logs.delete(streamId);
  }

  /**
   * Async reload entries from disk if they were released. No-op when already
   * resident or when the stream is unknown.
   */
  async ensureLoaded(streamId: StreamTabId): Promise<void> {
    if (this.logs.has(streamId)) return;
    if (!this.summaries.has(streamId)) return;
    const existing = this.pendingLoads.get(streamId);
    if (existing) return existing;
    const work = (async () => {
      try {
        const raw = await this.kv.read<unknown[]>(streamId);
        const entries = this.parsePersistedEntries(raw);
        const logInstance = new StreamLog(entries);
        this.logs.set(streamId, logInstance);
        this.refreshSummary(streamId, logInstance);
      } catch {
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

      let totalEntries = 0;
      for (const [streamId, entries] of results) {
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

    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      await this.executeWrite(resolve);
      return;
    }

    if (this.inFlightWrite) {
      await this.inFlightWrite;
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
    this.summaries.set(streamId, {
      firstTimestamp: logInstance.firstTimestamp,
      lastTimestamp: logInstance.lastTimestamp,
    });
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

    const dirtyIds = [...this.dirtyStreamIds];
    this.dirtyStreamIds.clear();

    if (dirtyIds.length === 0) {
      resolve?.();
      return Promise.resolve();
    }

    log.debug(LOG_TAG, `Writing ${dirtyIds.length} dirty stream(s)`);

    const writes = dirtyIds.flatMap((streamId) => {
      const logInstance = this.logs.get(streamId);
      return logInstance ? [this.kv.write(streamId, logInstance.toJSON())] : [];
    });

    const writePromise = Promise.all(writes)
      .then(() => {})
      .catch(() => {
        // Keep writes non-throwing on hot path.
      })
      .finally(() => {
        if (this.inFlightWrite === writePromise) {
          this.inFlightWrite = null;
          if (!this.pendingResolve) {
            this.savePromise = null;
          }
        }
        resolve?.();
      });

    this.inFlightWrite = writePromise;
    return writePromise;
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
