import pMap from 'p-map';
import { z } from 'zod';

import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { KVStore } from '@common/storage/KVStore';
import * as log from '@logger/logUtils';
import {
  END_GROUP_STATUS,
  PersistedStreamLogEntrySchema,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  type RunOutcome,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';
import { debounce, filterNotNull, isObject } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { StorageFS } from '@utils/files/storageFS';
import { formatResultCount } from '@utils/text/stringUtils';

import {
  isRunningGroupEntry,
  isRunningStreamingTextEntry,
  StreamLog,
  type StreamLogAppendInput,
  type StreamLogPreservedRawEntry,
  type StreamLogUpdatePatch,
} from './StreamLog';

const SAVE_DEBOUNCE_MS = 300;
export const STREAM_LOGS_DIR = WORKSPACE_STORAGE_LAYOUT.streamLogs;
export const STREAM_LOG_SUMMARIES_DIR = 'streamLogSummaries';
const STREAM_LOG_LOAD_CONCURRENCY = 8;
const LOG_TAG = 'StreamLogStore';

type StreamLogListener = (streamId: StreamTabId) => void;

const StreamLogSummarySchema = z.object({
  firstTimestamp: z.number().finite().optional().catch(undefined),
  lastTimestamp: z.number().finite().optional().catch(undefined),
  hasRunningGroup: z.boolean().optional().catch(undefined),
  hasRunningStreamingText: z.boolean().optional().catch(undefined),
});
type StreamLogSummary = z.infer<typeof StreamLogSummarySchema>;

interface StreamLoadResult {
  streamId: StreamTabId;
  summary: StreamLogSummary;
}

interface ParsedPersistedEntries {
  entries: StreamLogEntry[];
  preservedRawEntries: StreamLogPreservedRawEntry[];
}

type StreamLogStoreMode =
  | { readonly kind: 'persistent' }
  | { readonly kind: 'read-only' }
  | { readonly kind: 'ephemeral'; readonly reason: string };

export interface TranscriptWriter {
  readonly streamId: StreamTabId;
  append(entry: StreamLogAppendInput): StreamLogEntry;
  update(id: string, patch: StreamLogUpdatePatch): StreamLogEntry | undefined;
  appendText(id: string, text: string): StreamLogEntry | undefined;
  close(): void;
}

interface StreamWriterOwnership {
  readonly ownerKey: string;
  readonly tokens: Set<symbol>;
}

function summaryOf(logInstance: StreamLog): StreamLogSummary {
  return {
    firstTimestamp: logInstance.firstTimestamp,
    lastTimestamp: logInstance.lastTimestamp,
    hasRunningGroup: logInstance.hasRunningGroup,
    hasRunningStreamingText: logInstance.hasRunningStreamingText,
  };
}

/**
 * The ONE app-side read boundary for legacy `GROUP_START`/`GROUP_END`
 * `data.status` wire values (see
 * docs/proposals/session-scoped-runtime-architecture.md §8.3). Every live
 * producer now writes canonical `StreamPhase`/`RunOutcome` values directly
 * through `append()` (§8.2), so this only backfills rows that were already
 * persisted to disk before the cutover — `'running'` (row 1) is
 * string-identical to `StreamPhase.RUNNING`, so it passes through unchanged;
 * `'stopped'`/`'error'` (the pre-cutover 2-value `EndGroupStatus`) are
 * upgraded to the `RunOutcome` they folded. `'stopped'` -> `COMPLETED` is a
 * documented lossy default: the old 2-value fold already could not
 * distinguish completed from cancelled, and `COMPLETED` matches today's
 * neutral "Stopped" rendering, so no historical transcript's displayed label
 * changes — only its typed value does. `data` stays `z.unknown()` in
 * `PersistedStreamLogEntrySchema` (Tier 3 — opaque, pattern-matched by
 * display code), so this is a value transform layered on top of the existing
 * parse, not a schema change, and needs no persisted format-version bump.
 * Any other value (already-canonical post-cutover write, or malformed data)
 * passes through unchanged.
 */
function normalizeGroupStatusEntry(entry: StreamLogEntry): StreamLogEntry {
  if (
    entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_START &&
    entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_END
  ) {
    return entry;
  }
  if (!isObject(entry.data) || typeof entry.data.status !== 'string') {
    return entry;
  }
  switch (entry.data.status) {
    case END_GROUP_STATUS.STOPPED:
      return {
        ...entry,
        data: { ...entry.data, status: RUN_OUTCOME.COMPLETED },
      };
    case END_GROUP_STATUS.ERROR:
      return { ...entry, data: { ...entry.data, status: RUN_OUTCOME.FAILED } };
    default:
      return entry;
  }
}

/**
 * A persisted summary needs its stream force-loaded before the recovery
 * sweep can finalize anything left running — either an orphaned task group
 * or an orphaned thinking/scratchpad/model-response stream (#7276: these can
 * close independently, e.g. an error path that ends the group without also
 * finalizing an in-flight nested stream).
 */
function hasSomethingRunning(summary: StreamLogSummary | undefined): boolean {
  return (
    summary?.hasRunningGroup === true ||
    summary?.hasRunningStreamingText === true
  );
}

export class StreamLogStore {
  readonly mode: StreamLogStoreMode;

  private readonly logs = new Map<StreamTabId, StreamLog>();
  private readonly listeners = new Set<StreamLogListener>();
  private readonly dirtyStreamIds = new Set<StreamTabId>();
  private readonly kv = new KVStore(STREAM_LOGS_DIR, {
    compactJson: true,
    throwOnErrors: true,
  });
  private readonly summaryKv = new KVStore(STREAM_LOG_SUMMARIES_DIR, {
    compactJson: true,
    throwOnErrors: true,
  });

  /**
   * Lightweight summary per stream (first/last timestamp). Populated at open
   * or reload and refreshed on append/update. Survives eviction so sidebar
   * metadata stays available for streams whose heavy entries have been evicted.
   */
  private readonly summaries = new Map<StreamTabId, StreamLogSummary>();

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
   * Streams whose requested eviction is waiting for writers or persistence.
   * A read or writer acquisition clears the request; otherwise the store
   * evicts as soon as the remaining ownership and durability guards leave.
   */
  private readonly pendingRelease = new Set<StreamTabId>();
  /** Exact mutation capabilities currently keeping a stream resident. */
  private readonly writers = new Map<StreamTabId, StreamWriterOwnership>();

  /**
   * Streams whose rehydrate read from disk failed. While marked, saves skip
   * them so we never overwrite the authoritative disk copy with a fresh
   * empty-log-plus-new-appends that would drop persisted history.
   * Cleared when an explicit `ensureLoaded` retry succeeds; appends reject
   * while the stream remains in this state.
   */
  private readonly loadFailed = new Set<StreamTabId>();

  private readonly debouncedSave = debounce(
    () => this.executeWrite(),
    SAVE_DEBOUNCE_MS,
  );
  /**
   * Track save() awaiters so we can settle them when the debounced write is
   * cancelled (flush / delete / clear). perfect-debounce's cancel() drops
   * pending resolvers without settling them, which would hang any awaited
   * save() indefinitely.
   */
  private pendingSaveAwaiters: Array<() => void> = [];
  /**
   * Tracks the active write. A flush can cancel the debounce and start a write
   * while an already-queued debounce callback also runs; that is safe because
   * each write snapshots and clears `dirtyStreamIds`, so the second call only
   * sees newly dirtied streams or settles with no work.
   */
  private inFlightWrite: Promise<void> | null = null;
  private writeGeneration = 0;
  private readonly writeTombstones = new Set<StreamTabId>();
  private clearing = false;
  private stateRevision = 0;
  private pendingReload: Promise<void> | undefined;
  private summaryCacheMaintenanceEnabled = true;

  private constructor(mode: StreamLogStoreMode) {
    this.mode = Object.freeze(mode);
  }

  /** Open and validate the persistent transcript store before exposing it. */
  static async open(): Promise<StreamLogStore> {
    const store = new StreamLogStore({ kind: 'persistent' });
    await StorageFS.ensureDir(STREAM_LOGS_DIR);
    await store.prepareSummaryCache();
    store.replaceSummaries(await store.readPersistentSummaries());
    return store;
  }

  /** Open persisted transcripts for reading without creating or writing files. */
  static async openReadOnly(): Promise<StreamLogStore> {
    const store = new StreamLogStore({ kind: 'read-only' });
    store.replaceSummaries(await store.readPersistentSummaries());
    return store;
  }

  /** Create an explicitly non-persistent transcript store. */
  static ephemeral(reason: string): StreamLogStore {
    const normalizedReason = reason.trim();
    if (!normalizedReason) {
      throw new Error('An ephemeral transcript store requires a reason.');
    }
    return new StreamLogStore({
      kind: 'ephemeral',
      reason: normalizedReason,
    });
  }

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

  /** Return known streams whose summary records unfinished output. */
  getUnfinishedStreamIds(): StreamTabId[] {
    return [...this.summaries]
      .filter(([, summary]) => hasSomethingRunning(summary))
      .map(([streamId]) => streamId);
  }

  ensureStream(streamId: StreamTabId): void {
    this.assertWritableStore('ensure a transcript stream');
    // No-op if the stream is already known — either resident in `logs` or
    // released with metadata in `summaries`. Creating a fresh empty log here
    // for a released stream would shadow the on-disk copy from
    // `ensureLoaded`, leaving switches to that stream showing an empty view.
    if (this.logs.has(streamId) || this.summaries.has(streamId)) return;
    const logInstance = new StreamLog();
    this.logs.set(streamId, logInstance);
    this.summaries.set(streamId, {});
    this.stateRevision += 1;
    if (this.mode.kind === 'persistent') {
      this.markDirty(streamId);
      void this.save();
    }
  }

  /**
   * Drop heavy entries from memory while keeping the on-disk copy authoritative.
   * If there are pending writes, queue the release so `executeWrite` can flush
   * first and actually evict afterwards; otherwise releases immediately.
   * Subsequent access must go through `ensureLoaded` to rehydrate.
   */
  requestEviction(streamId: StreamTabId): void {
    // Ephemeral entries have no durable copy from which they could be restored.
    if (this.mode.kind === 'ephemeral') return;

    const logInstance = this.logs.get(streamId);
    if (!logInstance) {
      // Can't drop what isn't resident — but if a rehydrate is in flight,
      // queue the intent so it runs once the load completes. Otherwise the
      // rapid in-flight → stale flip would finish the load into memory
      // with no subsequent eviction trigger.
      if (this.writers.has(streamId) || this.pendingLoads.has(streamId)) {
        this.pendingRelease.add(streamId);
      }
      return;
    }
    if (
      this.writers.has(streamId) ||
      this.dirtyStreamIds.has(streamId) ||
      this.flushing.has(streamId)
    ) {
      this.pendingRelease.add(streamId);
      return;
    }
    this.pendingRelease.delete(streamId);
    this.refreshSummary(streamId, logInstance);
    this.logs.delete(streamId);
    this.stateRevision += 1;
  }

  /**
   * Rehydrate a stream and grant mutation authority to one logical execution.
   * Exact tokens make close idempotent and prevent an obsolete handle from
   * releasing a newer writer.
   */
  acquireWriter(streamId: StreamTabId, ownerKey: string): TranscriptWriter {
    return this.createWriter(streamId, ownerKey, false);
  }

  /**
   * Reserve mutation authority before rehydrating a released stream. The
   * reservation keeps a concurrent eviction request pending until the caller
   * receives and later closes the writer, so load and writer acquisition form
   * one ownership transition instead of two raceable calls.
   */
  async loadAndAcquireWriter(
    streamId: StreamTabId,
    ownerKey: string,
  ): Promise<TranscriptWriter> {
    const writer = this.createWriter(streamId, ownerKey, true);
    try {
      await this.ensureLoaded(streamId);
      return writer;
    } catch (error) {
      writer.close();
      throw error;
    }
  }

  private createWriter(
    streamId: StreamTabId,
    ownerKey: string,
    allowReleased: boolean,
  ): TranscriptWriter {
    this.assertWritableStore('acquire a transcript writer');
    if (!ownerKey.trim()) {
      throw new Error('A transcript writer requires a non-empty owner key.');
    }

    if (
      !allowReleased &&
      this.mode.kind === 'persistent' &&
      this.summaries.has(streamId) &&
      !this.logs.has(streamId)
    ) {
      throw new Error(
        `Cannot acquire a writer for released stream ${streamId}. Await ensureLoaded() first.`,
      );
    }

    const current = this.writers.get(streamId);
    if (current && current.ownerKey !== ownerKey) {
      throw new Error(
        `Transcript stream ${streamId} is already owned by another writer.`,
      );
    }
    const ownership =
      current ??
      ({ ownerKey, tokens: new Set() } satisfies StreamWriterOwnership);
    const token = Symbol(ownerKey);
    ownership.tokens.add(token);
    this.writers.set(streamId, ownership);
    let closed = false;

    const assertOwned = (): void => {
      if (
        closed ||
        this.writers.get(streamId) !== ownership ||
        !ownership.tokens.has(token)
      ) {
        throw new Error(`Transcript writer for ${streamId} has been released.`);
      }
    };

    return {
      streamId,
      append: (entry) => {
        assertOwned();
        return this.append(streamId, entry);
      },
      update: (id, patch) => {
        assertOwned();
        return this.update(streamId, id, patch);
      },
      appendText: (id, text) => {
        assertOwned();
        return this.appendText(streamId, id, text);
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (this.writers.get(streamId) !== ownership) return;
        ownership.tokens.delete(token);
        if (ownership.tokens.size > 0) return;
        this.writers.delete(streamId);
        this.drainPendingReleases();
      },
    };
  }

  /**
   * Async reload entries from disk if they were released. No-op when already
   * resident or when the stream is unknown.
   */
  async ensureLoaded(streamId: StreamTabId): Promise<void> {
    if (this.mode.kind === 'ephemeral') return;

    // A direct read reactivates the stream. A writer-reserved load instead
    // preserves an earlier eviction request until that writer closes.
    if (!this.writers.has(streamId)) this.pendingRelease.delete(streamId);
    // Normally skip when already resident. A concurrent append may have
    // populated a fresh log before a rehydrate failed, so a retry must still
    // reunite it with persisted history before saves are re-enabled.
    if (this.logs.has(streamId) && !this.loadFailed.has(streamId)) return;
    if (!this.summaries.has(streamId)) return;
    const existing = this.pendingLoads.get(streamId);
    if (existing) return existing;
    const work = (async () => {
      try {
        const raw = await this.kv.read<unknown[]>(streamId);
        // If `delete` or `clear` ran during the read, don't resurrect it.
        if (
          this.clearing ||
          this.writeTombstones.has(streamId) ||
          !this.summaries.has(streamId)
        ) {
          return;
        }
        const diskEntries = this.parsePersistedEntries(streamId, raw);
        const live = this.logs.get(streamId);
        if (live && live.size > 0) {
          // A concurrent `append` populated `logs` during the disk read.
          // Merge disk (history) before the live appends so `save()` writes
          // the union instead of clobbering the authoritative disk copy
          // with just the new entries. StreamLog's constructor re-numbers
          // seqNos so the merged view stays contiguous.
          const merged = new StreamLog(
            [...diskEntries.entries, ...live.toJSON()],
            diskEntries.preservedRawEntries,
          );
          this.logs.set(streamId, merged);
          this.stateRevision += 1;
          this.refreshSummary(streamId, merged);
          this.markDirty(streamId);
          void this.save();
          this.notify(streamId);
        } else {
          const logInstance = new StreamLog(
            diskEntries.entries,
            diskEntries.preservedRawEntries,
          );
          this.logs.set(streamId, logInstance);
          this.stateRevision += 1;
          this.refreshSummary(streamId, logInstance);
          // An eviction request that arrived while the load was in flight gets
          // queued; honor it now (unless a reactivation cleared the intent).
          if (
            this.pendingRelease.has(streamId) &&
            !this.writers.has(streamId)
          ) {
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
      } catch (err) {
        // Keep the disk copy authoritative and surface the failed read. A
        // caller may retry `ensureLoaded`, but no append is accepted until a
        // retry succeeds and reunites the in-memory view with persisted data.
        this.loadFailed.add(streamId);
        log.warn(
          LOG_TAG,
          `Failed to reload stream ${streamId} from disk: ` +
            toErrorMessage(err),
        );
        throw err;
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
    this.assertWritableStream(streamId);
    if (
      this.mode.kind === 'persistent' &&
      this.summaries.has(streamId) &&
      !this.logs.has(streamId) &&
      !this.pendingLoads.has(streamId)
    ) {
      throw new Error(
        `Cannot append to released stream ${streamId}. Await ensureLoaded() first.`,
      );
    }
    const logInstance = this.getOrCreate(streamId);
    const appended = logInstance.append(entry);
    this.commitChange(streamId, logInstance);
    void this.save();
    return appended;
  }

  update(
    streamId: StreamTabId,
    id: string,
    patch: StreamLogUpdatePatch,
  ): StreamLogEntry | undefined {
    this.assertWritableStream(streamId);
    const logInstance = this.logs.get(streamId);
    if (!logInstance) return undefined;

    const updated = logInstance.update(id, patch);
    if (!updated) return undefined;

    this.commitChange(streamId, logInstance);
    void this.save();
    return updated;
  }

  appendText(
    streamId: StreamTabId,
    id: string,
    appendText: string,
  ): StreamLogEntry | undefined {
    this.assertWritableStream(streamId);
    const logInstance = this.logs.get(streamId);
    if (!logInstance) return undefined;

    const updated = logInstance.appendText(id, appendText);
    if (!updated) return undefined;

    this.commitChange(streamId, logInstance);
    void this.save();
    return updated;
  }

  clearDirtyUpdates(streamId: StreamTabId): void {
    this.assertWritableStore('clear transcript update state');
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
    this.assertWritableStore('delete a transcript stream');
    this.writeTombstones.add(streamId);
    this.debouncedSave.cancel();

    try {
      await this.inFlightWrite;
      await this.executeWrite();
      if (this.mode.kind !== 'ephemeral') {
        log.info(LOG_TAG, `Deleting stream: ${streamId}`);
        await this.kv.delete(streamId);
        await this.deleteSummaryCache(streamId);
      }
      // The summaries map is the progress tab registry. Commit its removal
      // only after durable deletion succeeds so callers can retain and retry a
      // stream whose transcript cleanup failed.
      this.forgetStreamState(streamId);
      this.stateRevision += 1;
    } catch (error) {
      // executeWrite() drains dirty ids while the tombstone suppresses writes.
      // Restore the retry marker if deletion fails and a resident log remains.
      if (this.logs.has(streamId)) this.dirtyStreamIds.add(streamId);
      throw error;
    } finally {
      this.writeTombstones.delete(streamId);
    }
  }

  async clear(): Promise<void> {
    this.assertWritableStore('clear transcript streams');
    const count = this.summaries.size;
    this.clearing = true;
    this.writeGeneration += 1;
    this.cancelPendingSave();
    this.forgetAllStreamState();
    this.stateRevision += 1;

    try {
      await this.inFlightWrite;
      this.forgetAllStreamState();
      if (this.mode.kind === 'ephemeral') return;

      log.info(LOG_TAG, `Clearing all ${count} streams`);
      await this.kv.deleteDir();
      await this.clearSummaryCache();
    } finally {
      this.writeTombstones.clear();
      this.clearing = false;
    }
  }

  async endRunningGroups(
    now: number = Date.now(),
    streamIds: readonly StreamTabId[] = [],
    status: RunOutcome = RUN_OUTCOME.FAILED,
  ): Promise<StreamTabId[]> {
    this.assertWritableStore('finalize running transcript groups');
    const streamsToLoad = new Set(streamIds);
    for (const [streamId, summary] of this.summaries) {
      if (
        hasSomethingRunning(summary) &&
        (!this.logs.has(streamId) || this.loadFailed.has(streamId))
      ) {
        streamsToLoad.add(streamId);
      }
    }

    if (streamsToLoad.size > 0) {
      await pMap([...streamsToLoad], (id) => this.ensureLoaded(id), {
        concurrency: STREAM_LOG_LOAD_CONCURRENCY,
      });
    }

    const affected = this.endRunningEntriesInLoadedLogs(now, undefined, status);
    if (affected.length > 0) {
      void this.save();
    }

    return affected;
  }

  async endRunningGroupsForStreams(
    streamIds: readonly StreamTabId[],
    now: number = Date.now(),
    status: RunOutcome = RUN_OUTCOME.FAILED,
  ): Promise<StreamTabId[]> {
    this.assertWritableStore('finalize running transcript groups');
    if (streamIds.length === 0) return [];
    const streamsToLoad = streamIds.filter(
      (id) =>
        (!this.logs.has(id) || this.loadFailed.has(id)) &&
        hasSomethingRunning(this.summaries.get(id)),
    );
    if (streamsToLoad.length > 0) {
      await pMap(streamsToLoad, (id) => this.ensureLoaded(id), {
        concurrency: STREAM_LOG_LOAD_CONCURRENCY,
      });
    }

    const affected = this.endRunningEntriesInLoadedLogs(
      now,
      new Set(streamIds),
      status,
    );
    if (affected.length > 0) {
      void this.save();
    }

    return affected;
  }

  private endRunningEntriesInLoadedLogs(
    now: number,
    streamIds?: ReadonlySet<StreamTabId>,
    status: RunOutcome = RUN_OUTCOME.FAILED,
  ): StreamTabId[] {
    const affected: StreamTabId[] = [];
    for (const [streamId, logInstance] of this.logs.entries()) {
      if (streamIds && !streamIds.has(streamId)) continue;
      let updatedAny = false;
      for (const entry of logInstance.getRange(0, logInstance.head)) {
        if (isRunningGroupEntry(entry)) {
          const existingData = isObject(entry.data) ? entry.data : {};
          updatedAny ||= !!logInstance.update(entry.id, {
            type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
            data: { ...existingData, status, endTime: now },
          });
          continue;
        }

        // A thinking/scratchpad/model-response stream that never got a
        // `stream.end` (run cancelled/crashed/reloaded mid-stream) — finalize
        // it so it renders as its normal completed banner instead of being
        // stuck rendering as an in-progress entry forever (#7276).
        if (isRunningStreamingTextEntry(entry)) {
          const existingData = isObject(entry.data) ? entry.data : {};
          updatedAny ||= !!logInstance.update(entry.id, {
            data: { ...existingData, status: 'completed' },
          });
          continue;
        }
      }

      if (updatedAny) {
        affected.push(streamId);
        this.commitChange(streamId, logInstance);
      }
    }

    return affected;
  }

  /**
   * Transactionally reload persistent summaries. A failed read leaves the
   * previously valid in-memory state untouched and rejects to the host.
   */
  async reload(): Promise<void> {
    if (this.mode.kind === 'ephemeral') {
      throw new Error(
        `Cannot reload an ephemeral transcript store (${this.mode.reason}).`,
      );
    }
    if (this.pendingReload) return this.pendingReload;

    const work = this.executeReload();
    this.pendingReload = work;
    try {
      await work;
    } finally {
      if (this.pendingReload === work) this.pendingReload = undefined;
    }
  }

  save(): Promise<void> {
    this.assertWritableStore('save transcripts');
    if (this.mode.kind === 'ephemeral' || this.dirtyStreamIds.size === 0) {
      return Promise.resolve();
    }
    // Start/extend the debounce timer. perfect-debounce handles timer
    // management and returns a shared promise, but we ignore it and track
    // our own awaiters so we can settle them when the debounce is cancelled
    // during flush / delete / clear.
    this.debouncedSave();
    return new Promise<void>((resolve) => {
      this.pendingSaveAwaiters.push(resolve);
    });
  }

  async flush(): Promise<void> {
    this.assertWritableStore('flush transcripts');
    if (this.mode.kind === 'ephemeral') return;

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
      if (this.debouncedSave.isPending()) {
        this.debouncedSave.cancel();
        await this.executeWrite();
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
        if (!canRetry) {
          if (this.dirtyStreamIds.size > 0) {
            throw new Error(
              `Cannot flush ${this.dirtyStreamIds.size} stream(s) whose persisted transcripts failed to load.`,
            );
          }
          return;
        }
        if (writeAttempts >= MAX_WRITE_RETRIES) {
          throw new Error(
            `Transcript flush failed after ${MAX_WRITE_RETRIES} retries; ` +
              `${this.dirtyStreamIds.size} stream(s) remain dirty.`,
          );
        }
        await this.executeWrite();
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

  private assertWritableStream(streamId: StreamTabId): void {
    this.assertWritableStore('modify transcript entries');
    if (!this.loadFailed.has(streamId)) return;
    throw new Error(
      `Cannot modify stream ${streamId} after its persisted transcript failed to load. Retry ensureLoaded() first.`,
    );
  }

  /** Shared post-mutation bookkeeping for append/update/appendText/endRunningGroups. */
  private commitChange(streamId: StreamTabId, logInstance: StreamLog): void {
    this.assertWritableStore('commit transcript changes');
    this.refreshSummary(streamId, logInstance);
    this.stateRevision += 1;
    if (this.mode.kind === 'persistent') this.markDirty(streamId);
    this.notify(streamId);
  }

  private refreshSummary(streamId: StreamTabId, logInstance: StreamLog): void {
    // Mutate in place — no observer watches summary object identity, and
    // this runs on the per-append hot path (~200/s during streaming), so
    // avoiding the per-call allocation is worthwhile.
    const existing = this.summaries.get(streamId);
    if (existing) {
      existing.firstTimestamp = logInstance.firstTimestamp;
      existing.lastTimestamp = logInstance.lastTimestamp;
      existing.hasRunningGroup = logInstance.hasRunningGroup;
      existing.hasRunningStreamingText = logInstance.hasRunningStreamingText;
    } else {
      this.summaries.set(streamId, summaryOf(logInstance));
    }
  }

  private async executeReload(): Promise<void> {
    if (this.mode.kind === 'persistent') await this.flush();
    if (this.dirtyStreamIds.size > 0) {
      throw new Error(
        'Cannot reload transcripts while persistent writes remain unresolved.',
      );
    }

    const revision = this.stateRevision;
    const summaries = await this.readPersistentSummaries();
    if (revision !== this.stateRevision || this.pendingLoads.size > 0) {
      throw new Error(
        'Transcript state changed during reload; preserving the live state.',
      );
    }
    this.replaceSummaries(summaries);
  }

  private async readPersistentSummaries(): Promise<
    Map<StreamTabId, StreamLogSummary>
  > {
    const streamIds = await this.kv.listKeys();
    const results = await pMap(
      streamIds,
      (streamId) => this.loadStreamSummary(streamId as StreamTabId),
      { concurrency: STREAM_LOG_LOAD_CONCURRENCY },
    );
    const sortedResults = results
      .filter(filterNotNull)
      .sort(
        (a, b) =>
          (a.summary.firstTimestamp ?? Number.POSITIVE_INFINITY) -
            (b.summary.firstTimestamp ?? Number.POSITIVE_INFINITY) ||
          a.streamId.localeCompare(b.streamId),
      );

    return new Map(
      sortedResults.map(({ streamId, summary }) => [streamId, summary]),
    );
  }

  private replaceSummaries(
    summaries: ReadonlyMap<StreamTabId, StreamLogSummary>,
  ): void {
    this.logs.clear();
    this.summaries.clear();
    for (const [streamId, summary] of summaries) {
      this.summaries.set(streamId, summary);
    }
    this.dirtyStreamIds.clear();
    this.pendingRelease.clear();
    this.flushing.clear();
    this.loadFailed.clear();
    this.pendingLoads.clear();
    this.writers.clear();
    this.writeTombstones.clear();
    this.clearing = false;
    this.stateRevision += 1;

    log.info(
      LOG_TAG,
      `Loaded ${this.summaries.size} stream summaries (file-backed)`,
    );
  }

  private async loadStreamSummary(
    streamId: StreamTabId,
  ): Promise<StreamLoadResult | null> {
    const persistedSummary = await this.readSummary(streamId);
    if (persistedSummary) {
      return { streamId, summary: persistedSummary };
    }

    const raw = await this.kv.read<unknown[]>(streamId);
    // `listKeys()` found the stream, but it may have been deleted before the
    // read completed. Only an existing authoritative `[]` is registration
    // evidence; KVStore's missing-file `undefined` is not.
    if (raw === undefined) return null;
    const entries = this.parsePersistedEntries(streamId, raw);
    const summary = this.summarizeEntries(entries.entries);
    // Empty transcripts have no timestamps, so their authoritative log file,
    // rather than the optional summary cache, remains the registration marker.
    if (entries.entries.length > 0 || entries.preservedRawEntries.length > 0) {
      await this.maintainSummaryCache(streamId, summary);
    }
    return { streamId, summary };
  }

  private async readSummary(
    streamId: StreamTabId,
  ): Promise<StreamLogSummary | undefined> {
    try {
      const persisted = await this.summaryKv.read<unknown>(streamId);
      const summary = this.parsePersistedSummary(persisted);
      if (!summary) return undefined;

      const [summaryMtime, logMtime] = await Promise.all([
        this.summaryKv.modifiedAt(streamId),
        this.kv.modifiedAt(streamId),
      ]);
      if (
        summaryMtime !== undefined &&
        logMtime !== undefined &&
        summaryMtime < logMtime
      ) {
        return undefined;
      }

      return summary;
    } catch (error) {
      const condition =
        error instanceof SyntaxError ? 'corrupt' : 'unavailable';
      log.warn(
        LOG_TAG,
        `Ignoring ${condition} summary cache for ${streamId}; rebuilding from the stream log: ${toErrorMessage(error)}`,
      );
      return undefined;
    }
  }

  private summarizeEntries(
    entries: readonly StreamLogEntry[],
  ): StreamLogSummary {
    return {
      firstTimestamp: entries[0]?.timestamp,
      lastTimestamp: entries.at(-1)?.timestamp,
      hasRunningGroup: entries.some(isRunningGroupEntry),
      hasRunningStreamingText: entries.some(isRunningStreamingTextEntry),
    };
  }

  private parsePersistedSummary(value: unknown): StreamLogSummary | undefined {
    const result = StreamLogSummarySchema.safeParse(value);
    if (!result.success) return undefined;
    if (
      result.data.firstTimestamp === undefined &&
      result.data.lastTimestamp === undefined
    ) {
      return undefined;
    }
    return result.data;
  }

  private async writeStream(
    streamId: StreamTabId,
    logInstance: StreamLog,
    expectedGeneration: number = this.writeGeneration,
  ): Promise<void> {
    if (this.shouldSkipWrite(streamId, expectedGeneration)) return;
    await this.kv.write(streamId, logInstance.toPersistedEntries());
    if (this.shouldSkipWrite(streamId, expectedGeneration)) {
      await this.kv.delete(streamId);
      await this.deleteSummaryCache(streamId);
      return;
    }

    await this.maintainSummaryCache(streamId, summaryOf(logInstance));
    if (this.shouldSkipWrite(streamId, expectedGeneration)) {
      await this.kv.delete(streamId);
      await this.deleteSummaryCache(streamId);
    }
  }

  private shouldSkipWrite(
    streamId: StreamTabId,
    expectedGeneration: number,
  ): boolean {
    return (
      this.clearing ||
      expectedGeneration !== this.writeGeneration ||
      this.writeTombstones.has(streamId) ||
      !this.summaries.has(streamId)
    );
  }

  private forgetStreamState(streamId: StreamTabId): void {
    this.logs.delete(streamId);
    this.summaries.delete(streamId);
    this.dirtyStreamIds.delete(streamId);
    this.pendingRelease.delete(streamId);
    this.flushing.delete(streamId);
    this.loadFailed.delete(streamId);
    this.pendingLoads.delete(streamId);
    this.writers.delete(streamId);
  }

  private forgetAllStreamState(): void {
    this.logs.clear();
    this.summaries.clear();
    this.dirtyStreamIds.clear();
    this.pendingRelease.clear();
    this.flushing.clear();
    this.loadFailed.clear();
    this.pendingLoads.clear();
    this.writers.clear();
  }

  private assertWritableStore(operation: string): void {
    if (this.mode.kind !== 'read-only') return;
    throw new Error(`Cannot ${operation} with a read-only transcript store.`);
  }

  private async prepareSummaryCache(): Promise<void> {
    try {
      await StorageFS.ensureDir(STREAM_LOG_SUMMARIES_DIR);
    } catch (error) {
      this.disableSummaryCacheMaintenance(
        `Failed to prepare transcript summary cache; continuing with authoritative logs: ${toErrorMessage(error)}`,
      );
    }
  }

  private async maintainSummaryCache(
    streamId: StreamTabId,
    summary: StreamLogSummary,
  ): Promise<void> {
    if (
      this.mode.kind !== 'persistent' ||
      !this.summaryCacheMaintenanceEnabled
    ) {
      return;
    }
    try {
      await this.summaryKv.write(streamId, summary);
    } catch (error) {
      this.disableSummaryCacheMaintenance(
        `Failed to write transcript summary cache for ${streamId}: ${toErrorMessage(error)}`,
      );
    }
  }

  private async deleteSummaryCache(streamId: StreamTabId): Promise<void> {
    if (!this.summaryCacheMaintenanceEnabled) return;
    try {
      await this.summaryKv.delete(streamId);
    } catch (error) {
      this.disableSummaryCacheMaintenance(
        `Failed to delete transcript summary cache for ${streamId}: ${toErrorMessage(error)}`,
      );
    }
  }

  private async clearSummaryCache(): Promise<void> {
    if (!this.summaryCacheMaintenanceEnabled) return;
    try {
      await this.summaryKv.deleteDir();
    } catch (error) {
      this.disableSummaryCacheMaintenance(
        `Failed to clear transcript summary cache: ${toErrorMessage(error)}`,
      );
    }
  }

  private disableSummaryCacheMaintenance(message: string): void {
    if (!this.summaryCacheMaintenanceEnabled) return;
    this.summaryCacheMaintenanceEnabled = false;
    log.warn(LOG_TAG, message);
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
    this.debouncedSave.cancel();
    // `clear()` discards all streams, so there is nothing left for pending
    // save() callers to wait on.
    this.settlePendingSaveAwaiters();
  }

  private settlePendingSaveAwaiters(): void {
    const awaiters = this.pendingSaveAwaiters.splice(0);
    for (const resolve of awaiters) resolve();
  }

  private parsePersistedEntries(
    streamId: StreamTabId,
    rawEntries: unknown,
  ): ParsedPersistedEntries {
    const parsed: ParsedPersistedEntries = {
      entries: [],
      preservedRawEntries: [],
    };
    // A missing file reads as `undefined` (KVStore's quiet-missing contract):
    // an empty log, nothing to warn about. Anything else that isn't an array
    // is corrupt persisted data — throw so both callers route through the
    // same failure path as unparseable JSON (`ensureLoaded` marks the load
    // failed, which blocks saves from overwriting the on-disk file; startup
    // opening rejects). Returning an empty log here would
    // let a later save() destructively rewrite the corrupt source (#7464).
    if (rawEntries === undefined) return parsed;
    if (!Array.isArray(rawEntries)) {
      // `typeof null` is 'object', which would misreport a persisted null.
      const got = rawEntries === null ? 'null' : typeof rawEntries;
      throw new Error(
        `Stream ${streamId}: persisted log is not an array (got ${got}).`,
      );
    }

    for (const raw of rawEntries) {
      const result = PersistedStreamLogEntrySchema.safeParse(raw);
      if (result.success) {
        parsed.entries.push(normalizeGroupStatusEntry(result.data));
      } else {
        parsed.preservedRawEntries.push({
          beforeTypedIndex: parsed.entries.length,
          raw,
        });
      }
    }

    // Loud read (#7464): unparseable rows are invisible to the typed view,
    // so say they exist — but they are preserved verbatim and reinserted on
    // save, never silently deleted from disk.
    if (parsed.preservedRawEntries.length > 0) {
      const count = parsed.preservedRawEntries.length;
      log.warn(
        LOG_TAG,
        `Stream ${streamId}: ${formatResultCount(count, 'persisted transcript entry')} did not parse; ` +
          `preserving raw for round-trip on save.`,
      );
    }

    return parsed;
  }

  private executeWrite(): Promise<void> {
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
      this.settlePendingSaveAwaiters();
      return Promise.resolve();
    }

    // Snapshot current save awaiters so new save() calls during this write
    // get fresh awaiters for the next debounce window. We settle these after
    // the write completes (success or failure) so flush / delete / clear
    // don't strand callers that are awaiting save().
    const awaiters = this.pendingSaveAwaiters.splice(0);

    log.debug(LOG_TAG, `Writing ${dirtyIds.length} dirty stream(s)`);
    const writeGeneration = this.writeGeneration;

    // Mark these as mid-flush so eviction defers — we need the
    // in-memory copy preserved until the write resolves, otherwise a failed
    // write can't re-mark the stream dirty (there'd be no log entries left).
    for (const streamId of dirtyIds) this.flushing.add(streamId);

    // Write streams one at a time. Each KV write serializes the stream's full
    // transcript to JSON before the filesystem await; starting every dirty
    // stream together retains all of those large JSON strings simultaneously.
    // Sequential writes keep peak memory proportional to one serialized
    // transcript while preserving independent per-stream failure handling.
    const writePromise = (async () => {
      for (const streamId of dirtyIds) {
        const logInstance = this.logs.get(streamId);
        if (!logInstance) continue;
        try {
          await this.writeStream(streamId, logInstance, writeGeneration);
        } catch {
          // Failed writes re-mark their stream dirty so the next save retries.
          // Continue draining the batch so one unavailable file does not
          // prevent unrelated transcripts from becoming durable.
          if (this.logs.has(streamId)) this.dirtyStreamIds.add(streamId);
        }
      }
    })().finally(() => {
      for (const streamId of dirtyIds) this.flushing.delete(streamId);
      if (this.inFlightWrite === writePromise) {
        this.inFlightWrite = null;
      }
      this.drainPendingReleases();
      // Settle the snapshotted save awaiters — on failure the dirty
      // streams have already been re-marked for retry, so resolve
      // regardless.
      for (const resolve of awaiters) resolve();
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
      if (
        this.writers.has(streamId) ||
        this.dirtyStreamIds.has(streamId) ||
        this.flushing.has(streamId)
      ) {
        continue;
      }
      this.pendingRelease.delete(streamId);
      const logInstance = this.logs.get(streamId);
      if (!logInstance) continue;
      this.refreshSummary(streamId, logInstance);
      this.logs.delete(streamId);
    }
  }
}
