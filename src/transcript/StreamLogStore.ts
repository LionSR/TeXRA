import { isDeepStrictEqual } from 'node:util';
import pMap from 'p-map';
import PQueue from 'p-queue';
import { z } from 'zod';

import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { KVStore } from '@common/storage/KVStore';
import { KVStoreCache } from '@common/storage/KVStoreCache';
import { createLog } from '@logger/logUtils';
import {
  AgentCategorySchema,
  END_GROUP_STATUS,
  ExecutionIdSchema,
  RUN_OUTCOME,
  RunIdentitySchema,
  STREAM_LOG_ENTRY_TYPES,
  StreamLogEntrySchema,
  UserFollowUpSupportSchema,
  type RunOutcome,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';
import { createFlushableDebounce, filterNotNull, isObject } from '@utils/core';
import { createListenerSet } from '@utils/core/listenerSet';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { StorageFS } from '@utils/files/storageFS';
import { formatResultCount } from '@utils/text/stringUtils';

import { ResidentStreamRegistry } from './ResidentStreamRegistry';
import {
  isRunningGroupEntry,
  isRunningStreamingTextEntry,
  nonterminalWorkflowCall,
  StreamLog,
  type StreamLogAppendInput,
  type StreamLogDelta,
  type StreamLogPreservedRawEntry,
  type StreamLogUpdatePatch,
} from './StreamLog';

const SAVE_MAX_WAIT_MS = 300;
export const STREAM_LOGS_DIR = WORKSPACE_STORAGE_LAYOUT.streamLogs;
export const STREAM_LOG_SUMMARIES_DIR =
  WORKSPACE_STORAGE_LAYOUT.streamLogSummaries;
const STREAM_LOG_LOAD_CONCURRENCY = 8;
const LOG_TAG = 'StreamLogStore';
const log = createLog(LOG_TAG);

type StreamLogListener = (streamId: StreamTabId, delta: StreamLogDelta) => void;

/**
 * Snapshot-owned display metadata mirrored into the always-resident summary,
 * so sidebars and all-streams metadata paths never read the per-stream
 * sidecar files (#9947, PRD 2026-08-11). `StreamSnapshotStore` is the
 * authority and publishes a whole replacement object on every metadata
 * mutation and on every sidecar hydration (which lazily backfills legacy
 * summaries written before this field existed). Bounded scalars only:
 * `command` carries a process run's command line, never an agent run's
 * full instruction text.
 */
const StreamSummaryMetaSchema = z.object({
  identity: RunIdentitySchema.optional(),
  executionId: ExecutionIdSchema.optional(),
  parentStreamId: z.string().min(1).optional(),
  userFollowUpSupport: UserFollowUpSupportSchema.optional(),
  agentCategory: AgentCategorySchema.optional(),
  description: z.string().optional(),
  model: z.string().optional(),
  workingDirectory: z.string().optional(),
  command: z.string().optional(),
});
export type StreamSummaryMeta = z.infer<typeof StreamSummaryMetaSchema>;

// No per-field `.catch()`: this schema covers the crash-recovery flags
// (`hasRunningGroup`, `hasRunningStreamingText`, `hasNonterminalWorkflowCall`)
// that `hasSomethingRunning()` gates orphan recovery on. A `.catch()` here
// would silently turn a malformed field into `undefined` (recovery skipped)
// instead of failing the whole `safeParse`, which routes through the
// "ignore cache, rebuild from stream log" fallback in `readSummary` — the
// derived-tier discard+rebuild contract (#9434): a stale-shaped summary is
// discarded and rebuilt from the authoritative stream log (its `meta` block
// is rebuilt lazily by the snapshot store's next publish), never migrated.
const StreamLogSummarySchema = z.object({
  firstTimestamp: z.number().finite().optional(),
  lastTimestamp: z.number().finite().optional(),
  hasRunningGroup: z.boolean().optional(),
  hasRunningStreamingText: z.boolean().optional(),
  hasNonterminalWorkflowCall: z.boolean().optional(),
  meta: StreamSummaryMetaSchema.optional(),
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

/**
 * The user-facing warning an interactive host shows once it is running on an
 * ephemeral transcript store, built from that store's `mode.reason`.
 */
export function ephemeralTranscriptWarning(reason: string): string {
  return `Transcript persistence is unavailable for this session. Its conversation cannot be resumed. ${reason}`;
}

export interface TranscriptWriter {
  readonly streamId: StreamTabId;
  append(entry: StreamLogAppendInput): StreamLogEntry;
  appendSettled(entry: StreamLogAppendInput): StreamLogEntry;
  update(id: string, patch: StreamLogUpdatePatch): StreamLogEntry | undefined;
  settle(id: string, patch: StreamLogUpdatePatch): StreamLogEntry | undefined;
  appendText(id: string, text: string): StreamLogEntry | undefined;
  close(): void;
}

interface StreamWriterOwnership {
  readonly ownerKey: string;
  readonly tokens: Set<symbol>;
}

type TranscriptResidencyLeaseReason = 'writer' | 'focus' | 'flush';

/** Exact presentation ownership of one resident transcript. */
export interface TranscriptPresentationLease {
  readonly streamId: StreamTabId;
  close(): void;
}

/**
 * Every per-stream field that shares the resident stream lifecycle, keyed by
 * stream id in ONE map (`streams`, a {@link ResidentStreamRegistry}) instead
 * of parallel hand-synced maps/sets. Because every field for a stream lives
 * on the same object, dropping a stream's resident state is one
 * `streams.delete(id)` — every field disappears with it BY CONSTRUCTION,
 * which is what lets `forgetStreamState` / `forgetAllStreamState` collapse to
 * a single delete/clear. When an individual field is cleared,
 * `pruneStreamState` removes the record once no field remains, preserving
 * the old "absent from every collection" memory footprint.
 *
 * `summaries` (deliberately OUTLIVES per-stream eviction so sidebar metadata
 * survives when heavy `log` entries are dropped) and `writeTombstones` (a
 * short-lived delete/clear guard that `forgetStreamState` intentionally does
 * NOT touch, and only `replaceSummaries` clears) stay as their own maps on the
 * store — they do not share this lifecycle.
 */
interface StreamState {
  /**
   * Heavy in-memory entries. Dropped on eviction (`requestEviction`) while the
   * on-disk copy stays authoritative; the summary in `summaries` survives so
   * the stream remains a known, listable stream. `undefined` = released.
   */
  log?: StreamLog;
  /** Reasons that currently require the heavy transcript to stay resident. */
  leases?: Set<TranscriptResidencyLeaseReason>;
  /** Exact presentation capabilities currently retaining this transcript. */
  presentationLeases?: Set<symbol>;
  /**
   * Membership flag: this stream's rehydrate read from disk failed. While set,
   * saves skip it so we never overwrite the authoritative disk copy with a
   * fresh empty-log-plus-new-appends that would drop persisted history.
   * Cleared when an explicit `ensureLoaded` retry succeeds; appends reject
   * while it remains set.
   */
  loadFailed?: boolean;
  /** In-flight `ensureLoaded`; deduplicates concurrent calls for one stream. */
  pendingLoad?: Promise<void>;
  /** Exact mutation capabilities currently keeping a stream resident. */
  writer?: StreamWriterOwnership;
}

/**
 * Shared projection into {@link StreamLogSummary}, fed either by a resident
 * `StreamLog` (whose getters satisfy this shape) or by a raw entries scan
 * (`summarizeEntries`). Keeping the field list here means a new derived flag
 * is added once instead of in two hand-synced call sites.
 */
interface SummarySource {
  readonly firstTimestamp: number | undefined;
  readonly lastTimestamp: number | undefined;
  readonly hasRunningGroup: boolean;
  readonly hasRunningStreamingText: boolean;
  readonly hasNonterminalWorkflowCall: boolean;
}

function toSummary(source: SummarySource): StreamLogSummary {
  return {
    firstTimestamp: source.firstTimestamp,
    lastTimestamp: source.lastTimestamp,
    hasRunningGroup: source.hasRunningGroup,
    hasRunningStreamingText: source.hasRunningStreamingText,
    ...(source.hasNonterminalWorkflowCall
      ? { hasNonterminalWorkflowCall: true }
      : {}),
  };
}

/**
 * The ONE app-side read boundary for legacy `GROUP_START`/`GROUP_END`
 * `data.status` wire values (see
 * docs/proposals/2026-07-03-session-scoped-runtime-architecture.md §8.3). Every live
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
 * `StreamLogEntrySchema` (Tier 3 — opaque, pattern-matched by
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
    summary?.hasRunningStreamingText === true ||
    summary?.hasNonterminalWorkflowCall === true
  );
}

export class StreamLogStore {
  readonly mode: StreamLogStoreMode;

  /**
   * All per-stream resident state (heavy log, leases, load failure, pending
   * release/load, active writer) in one record per stream. See
   * {@link StreamState}. `summaries`, `writeTombstones`, and `dirtyIds` are
   * deliberately kept separate because they do not share this lifecycle.
   */
  private readonly streams = new ResidentStreamRegistry<
    StreamTabId,
    StreamState
  >(() => ({}));
  /**
   * Streams with unsaved changes awaiting `executeWrite`, kept as a dedicated
   * set (not a `StreamState` field) so the `save()` hot path can test
   * dirtiness in O(1) via `.size`/`.has` instead of scanning every record.
   * A dirty stream always has a resident `log` (or a deferred `loadFailed`/
   * `pendingLoad` record), so its `StreamState` is never pruned while it is
   * still listed here — see `pruneStreamState`.
   */
  private readonly dirtyIds = new Set<StreamTabId>();
  /**
   * Streams that return to cold storage whenever their leases drain. This
   * policy outlives resident state so a terminal stream remains cold after a
   * late writer; direct focus clears it.
   */
  private readonly releaseRequests = new Set<StreamTabId>();
  private readonly listeners = createListenerSet<StreamLogListener>();
  /**
   * Lazily-created handles over the two fixed transcript directories, keyed
   * by directory. Dropped wholesale on storage-root reload so the next
   * access re-resolves against the new root.
   */
  private readonly kvHandles = new KVStoreCache<string>(
    (dir) => new KVStore(dir, { compactJson: true }),
  );

  /**
   * Lightweight summary per stream (first/last timestamp). Populated at open
   * or reload and refreshed on append/update. Survives eviction so sidebar
   * metadata stays available for streams whose heavy entries have been evicted.
   */
  private readonly summaries = new Map<StreamTabId, StreamLogSummary>();

  /**
   * Antechamber for snapshot metadata recorded before its stream is
   * registered (run facts project ahead of `ensureStream`). Never listed —
   * `has()`/`keys()` stay `summaries`-based — and adopted into the summary
   * at registration; dropped with the stream otherwise.
   */
  private readonly pendingSummaryMeta = new Map<
    StreamTabId,
    StreamSummaryMeta
  >();

  /**
   * Max-wait throttle for the persistence path: the first dirty mutation in a
   * window starts the timer and later mutations join it without resetting it
   * (`scheduleSave`'s `pending` guard), so sustained sub-window appends still
   * produce a durable write every SAVE_MAX_WAIT_MS instead of starving a
   * trailing debounce. A crash mid-stream loses at most one window.
   */
  private readonly saveThrottle = createFlushableDebounce(
    () => void this.executeWrite(),
    SAVE_MAX_WAIT_MS,
  );
  /**
   * Serializes write batches: a throttle window, a flush, or a delete that
   * starts a write while one is still in flight queues behind it instead of
   * racing it, so two batches can never persist the same stream out of order.
   */
  private readonly writeQueue = new PQueue({ concurrency: 1 });
  private writeGeneration = 0;
  private readonly writeTombstones = new Set<StreamTabId>();
  private clearing = false;
  private stateRevision = 0;
  private pendingReload: Promise<void> | undefined;
  private summaryCacheMaintenanceEnabled = true;

  private constructor(mode: StreamLogStoreMode) {
    this.mode = Object.freeze(mode);
  }

  /** Handle over `STREAM_LOGS_DIR`; re-resolved after a storage-root reload. */
  private kv(): KVStore {
    return this.kvHandles.get(STREAM_LOGS_DIR);
  }

  /** Handle over `STREAM_LOG_SUMMARIES_DIR`; same lifecycle as `kv()`. */
  private summaryKv(): KVStore {
    return this.kvHandles.get(STREAM_LOG_SUMMARIES_DIR);
  }

  // -- StreamState record access -------------------------------------------
  // The `streams` map holds one record per resident stream. Field reads are
  // done inline (`this.streams.get(id)?.field`); only get-or-create, the
  // empty-record prune, and the two multi-caller iterations are factored out.

  private ensureStreamState(streamId: StreamTabId): StreamState {
    return this.streams.getOrCreate(streamId);
  }

  /**
   * Drop a record once none of its fields hold state, so an idle stream costs
   * no memory. Dirtiness lives in the separate `dirtyIds` set and is
   * intentionally NOT consulted here: a dirty stream always retains a `log`
   * (or a `loadFailed`/`pendingLoad` deferral record), so the field checks
   * below already keep its record alive.
   */
  private pruneStreamState(streamId: StreamTabId): void {
    this.streams.pruneIfEmpty(
      streamId,
      (s) =>
        s.log === undefined &&
        (s.leases === undefined || s.leases.size === 0) &&
        (s.presentationLeases === undefined ||
          s.presentationLeases.size === 0) &&
        !s.loadFailed &&
        s.pendingLoad === undefined &&
        s.writer === undefined,
    );
  }

  /** Snapshot of streams with unsaved changes (list form of `dirtyIds`). */
  private dirtyStreamIds(): StreamTabId[] {
    return [...this.dirtyIds];
  }

  /** In-flight `ensureLoaded` promises across every resident stream. */
  private pendingLoads(): Promise<void>[] {
    const loads: Promise<void>[] = [];
    for (const state of this.streams.values()) {
      if (state.pendingLoad) loads.push(state.pendingLoad);
    }
    return loads;
  }

  /**
   * True when a stream's persisted entries are not usable in memory: either
   * never rehydrated, or rehydrated into a log whose disk read failed.
   */
  private needsReload(streamId: StreamTabId): boolean {
    const state = this.streams.get(streamId);
    return state?.log === undefined || state.loadFailed === true;
  }

  /** Open and validate the persistent transcript store before exposing it. */
  static async open(): Promise<StreamLogStore> {
    const store = new StreamLogStore({ kind: 'persistent' });
    await StorageFS.ensureDir(STREAM_LOGS_DIR);
    await store.prepareSummaryCache();
    store.replaceSummaries(await store.readPersistentSummaries());
    return store;
  }

  /**
   * Open persisted transcripts for reading ONE known stream, seeding only
   * that stream's summary — `listKeys` plus a summary read and mtime stats
   * for just that stream, so archive consumers that already know which
   * stream they need (via the execution→stream mapping) pay O(1) instead of
   * a whole-directory scan. (The scan-all `openReadOnly` variant was deleted
   * with #9947's surface-neutral rework: it had no production caller.)
   * An unknown `streamId` yields a store that simply has no such stream, so
   * `ensureLoaded` no-ops and `get` returns `undefined` exactly as with a
   * full open that did not find the stream.
   */
  static async openReadOnlyForStream(
    streamId: StreamTabId,
  ): Promise<StreamLogStore> {
    const store = new StreamLogStore({ kind: 'read-only' });
    const result = await store.loadStreamSummary(streamId);
    if (result) store.summaries.set(result.streamId, result.summary);
    return store;
  }

  /**
   * Open the persistent transcript store, degrading to an in-memory store
   * when the open fails.
   *
   * Interactive hosts (VS Code extension, desktop app, CLI TUI) use this so a
   * broken transcript directory warns instead of aborting startup. The
   * degradation is loud: the cause is logged here and recorded in
   * `mode.reason`, which callers render through
   * {@link ephemeralTranscriptWarning}. A non-persistent store also disables
   * resume — `SessionHandle` skips restart repair and nothing was persisted
   * to resume from.
   */
  static async openOrEphemeral(
    open: () => Promise<StreamLogStore> = () => StreamLogStore.open(),
  ): Promise<StreamLogStore> {
    try {
      return await open();
    } catch (error) {
      const reason = `Persistent transcript opening failed: ${toErrorMessage(error)}`;
      log.warn(reason);
      return StreamLogStore.ephemeral(reason);
    }
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
    return this.listeners.add(listener);
  }

  get(streamId: StreamTabId): StreamLog | undefined {
    return this.streams.get(streamId)?.log;
  }

  /** Read a transcript once without adding it to the resident set. */
  async readEntries(streamId: StreamTabId): Promise<StreamLogEntry[]> {
    const resident = this.streams.get(streamId)?.log;
    if (resident) return resident.toJSON();
    if (this.mode.kind === 'ephemeral' || !this.summaries.has(streamId)) {
      return [];
    }
    const raw = await this.kv().read<unknown[]>(streamId);
    const parsed = this.parsePersistedEntries(streamId, raw);
    return new StreamLog(parsed.entries, parsed.preservedRawEntries).toJSON();
  }

  has(streamId: StreamTabId): boolean {
    // `summaries` is the authoritative registry of known streams and is
    // always a superset of resident logs (every entry we ever write to a
    // stream's `log` also lands in `summaries`; eviction drops the log but
    // keeps the summary).
    return this.summaries.has(streamId);
  }

  /**
   * Recheck the authoritative transcript source rather than this instance's
   * cached summary. Resume admission uses this while holding the execution
   * lease lock, so another process cannot delete a stream and have a stale
   * in-memory store recreate it afterwards.
   */
  async hasAuthoritativeStream(streamId: StreamTabId): Promise<boolean> {
    if (this.mode.kind === 'ephemeral') return this.has(streamId);
    return this.kv().exists(streamId);
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

  /**
   * The snapshot-owned display metadata mirrored into this stream's summary,
   * or `undefined` for a stream whose summary predates the mirror (legacy
   * rows backfill lazily on their next sidecar hydration). Metadata recorded
   * ahead of stream registration is served from the antechamber, so a run
   * fact that projects before `ensureStream` is never invisible.
   */
  getSummaryMeta(streamId: StreamTabId): StreamSummaryMeta | undefined {
    return (
      this.summaries.get(streamId)?.meta ??
      this.pendingSummaryMeta.get(streamId)
    );
  }

  /**
   * Record the snapshot store's current metadata for a stream in its
   * always-resident summary (memory now, summary cache asynchronously).
   * Whole-object replacement — the publisher owns field lifecycles — and a
   * deep-equal no-op gate, so the startup hydration sweep republishing
   * unchanged metadata for every stream costs no writes. A stream this store
   * does not know yet holds its metadata in `pendingSummaryMeta`: `summaries`
   * is the tab registry and registering here would mint a phantom stream, but
   * run facts legitimately project ahead of registration, so the metadata
   * waits in the antechamber and lands when `ensureStream` (or the first
   * append) registers the stream.
   */
  recordSummaryMeta(streamId: StreamTabId, meta: StreamSummaryMeta): void {
    this.assertWritableStore('record stream summary metadata');
    const summary = this.summaries.get(streamId);
    if (!summary) {
      if (isDeepStrictEqual(this.pendingSummaryMeta.get(streamId), meta))
        return;
      this.pendingSummaryMeta.set(streamId, meta);
      this.stateRevision += 1;
      return;
    }
    this.pendingSummaryMeta.delete(streamId);
    if (isDeepStrictEqual(summary.meta, meta)) return;
    summary.meta = meta;
    this.stateRevision += 1;
    // Share the transcript queue so flush/reload drains this write before a
    // storage-root change. Re-read at execution time, and let a dirty
    // transcript's own write carry the metadata: persisting its newer
    // log-derived summary fields before the authoritative log would make a
    // crash-time cache look more durable than it is.
    void this.writeQueue.add(async () => {
      if (this.dirtyIds.has(streamId)) return;
      const current = this.summaries.get(streamId);
      if (current) await this.maintainSummaryCache(streamId, { ...current });
    });
  }

  /** Land metadata recorded before this stream existed in the registry. */
  private adoptPendingSummaryMeta(streamId: StreamTabId): void {
    const pending = this.pendingSummaryMeta.get(streamId);
    if (pending === undefined) return;
    this.recordSummaryMeta(streamId, pending);
  }

  ensureStream(streamId: StreamTabId): void {
    this.assertWritableStore('ensure a transcript stream');
    // No-op if the stream is already known — either resident (`log`) or
    // released with metadata in `summaries`. Creating a fresh empty log here
    // for a released stream would shadow the on-disk copy from
    // `ensureLoaded`, leaving switches to that stream showing an empty view.
    if (
      this.streams.get(streamId)?.log !== undefined ||
      this.summaries.has(streamId)
    )
      return;
    this.ensureStreamState(streamId).log = new StreamLog();
    this.summaries.set(streamId, {});
    this.adoptPendingSummaryMeta(streamId);
    this.stateRevision += 1;
    if (this.mode.kind === 'persistent') {
      this.markDirty(streamId);
      this.scheduleSave();
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

    const state = this.streams.get(streamId);
    if (!state && !this.summaries.has(streamId)) return;
    this.releaseRequests.add(streamId);
    if (state) {
      state.leases?.delete('focus');
      if (state.leases?.size === 0) state.leases = undefined;
    }
    this.tryRelease(streamId);
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
      await this.hydrateStream(streamId, 'writer');
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
      this.streams.get(streamId)?.log === undefined
    ) {
      throw new Error(
        `Cannot acquire a writer for released stream ${streamId}. Await ensureLoaded() first.`,
      );
    }

    const current = this.streams.get(streamId)?.writer;
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
    const writerState = this.ensureStreamState(streamId);
    writerState.writer = ownership;
    this.acquireLease(streamId, 'writer');
    let closed = false;

    const assertOwned = (): void => {
      if (
        closed ||
        this.streams.get(streamId)?.writer !== ownership ||
        !ownership.tokens.has(token)
      ) {
        throw new Error(`Transcript writer for ${streamId} has been released.`);
      }
    };

    return {
      streamId,
      append: (entry) => {
        assertOwned();
        return this.appendEntry(streamId, entry, false);
      },
      appendSettled: (entry) => {
        assertOwned();
        return this.appendEntry(streamId, entry, true);
      },
      update: (id, patch) => {
        assertOwned();
        return this.mutateEntry(streamId, (log) => log.update(id, patch));
      },
      settle: (id, patch) => {
        assertOwned();
        return this.mutateEntry(streamId, (log) => log.settle(id, patch));
      },
      appendText: (id, text) => {
        assertOwned();
        return this.mutateEntry(streamId, (log) => log.appendText(id, text));
      },
      close: () => {
        if (closed) return;
        closed = true;
        const state = this.streams.get(streamId);
        if (!state || state.writer !== ownership) return;
        ownership.tokens.delete(token);
        if (ownership.tokens.size > 0) return;
        state.writer = undefined;
        this.releaseLease(streamId, 'writer');
      },
    };
  }

  async ensureLoaded(
    streamId: StreamTabId,
    options: { retainForPresentation: true },
  ): Promise<TranscriptPresentationLease>;
  async ensureLoaded(streamId: StreamTabId): Promise<void>;
  /**
   * Async reload entries from disk if they were released. No-op when already
   * resident or when the stream is unknown. A presentation may request an
   * exact lease so closing an obsolete selection cannot release a newer one.
   */
  async ensureLoaded(
    streamId: StreamTabId,
    options?: { retainForPresentation: true },
  ): Promise<void | TranscriptPresentationLease> {
    if (!options?.retainForPresentation) {
      await this.hydrateStream(streamId, 'focus');
      return;
    }
    if (
      this.mode.kind === 'ephemeral' ||
      (this.streams.get(streamId) === undefined &&
        !this.summaries.has(streamId))
    ) {
      return { streamId, close: () => undefined };
    }

    const token = Symbol(streamId);
    const state = this.ensureStreamState(streamId);
    state.presentationLeases ??= new Set();
    state.presentationLeases.add(token);
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      const current = this.streams.get(streamId);
      current?.presentationLeases?.delete(token);
      if (current?.presentationLeases?.size === 0) {
        current.presentationLeases = undefined;
      }
      // A presentation lease makes a historical transcript resident. Once
      // the final exact owner leaves, request eviction even when no lifecycle
      // status event previously did so.
      this.requestEviction(streamId);
      this.pruneStreamState(streamId);
    };

    try {
      await this.hydrateStream(streamId, 'presentation');
      return { streamId, close };
    } catch (error) {
      close();
      throw error;
    }
  }

  private async hydrateStream(
    streamId: StreamTabId,
    reason: 'focus' | 'presentation' | 'writer',
  ): Promise<void> {
    if (this.mode.kind === 'ephemeral') return;

    const reserved = this.streams.get(streamId);
    if (!reserved && !this.summaries.has(streamId)) return;
    if (reason === 'focus') {
      this.acquireLease(streamId, 'focus');
      this.releaseRequests.delete(streamId);
    }
    // Normally skip when already resident. A concurrent append may have
    // populated a fresh log before a rehydrate failed, so a retry must still
    // reunite it with persisted history before saves are re-enabled.
    const state = this.streams.get(streamId);
    if (state?.log !== undefined && state.loadFailed !== true) return;
    if (!this.summaries.has(streamId)) return;
    if (state?.pendingLoad) return state.pendingLoad;
    const work = (async () => {
      try {
        const raw = await this.kv().read<unknown[]>(streamId);
        // If `delete` or `clear` ran during the read, don't resurrect it.
        if (
          this.clearing ||
          this.writeTombstones.has(streamId) ||
          !this.summaries.has(streamId)
        ) {
          return;
        }
        const diskEntries = this.parsePersistedEntries(streamId, raw);
        const live = this.streams.get(streamId)?.log;
        if (live && live.size > 0) {
          // A concurrent `append` populated the log during the disk read.
          // Merge disk (history) before the live appends so `save()` writes
          // the union instead of clobbering the authoritative disk copy
          // with just the new entries. StreamLog's constructor re-numbers
          // seqNos so the merged view stays contiguous.
          const merged = new StreamLog(
            [...diskEntries.entries, ...live.toJSON()],
            diskEntries.preservedRawEntries,
          );
          this.ensureStreamState(streamId).log = merged;
          this.stateRevision += 1;
          this.refreshSummary(streamId, merged);
          this.markDirty(streamId);
          this.scheduleSave();
          // The merge renumbered seqNos under a fresh log instance, so
          // fold-state consumers must rebuild rather than apply a delta.
          this.notify(streamId, { reset: true });
        } else {
          const logInstance = new StreamLog(
            diskEntries.entries,
            diskEntries.preservedRawEntries,
          );
          const state = this.ensureStreamState(streamId);
          state.log = logInstance;
          this.stateRevision += 1;
          this.refreshSummary(streamId, logInstance);
          // An eviction request that arrived while the load was in flight gets
          // queued; honor it now (unless a reactivation cleared the intent).
          this.tryRelease(streamId);
        }
        // Load recovered — saves can persist this stream again. If a save
        // was deferred while the load was in flight (dirty stream re-queued
        // by executeWrite), flush it now so we don't wait for another
        // append to unblock it.
        const recovered = this.streams.get(streamId);
        if (recovered) recovered.loadFailed = false;
        if (this.dirtyIds.has(streamId)) this.scheduleSave();
      } catch (err) {
        // Keep the disk copy authoritative and surface the failed read. A
        // caller may retry `ensureLoaded`, but no append is accepted until a
        // retry succeeds and reunites the in-memory view with persisted data.
        this.ensureStreamState(streamId).loadFailed = true;
        log.warn(
          `Failed to reload stream ${streamId} from disk: ` +
            toErrorMessage(err),
        );
        throw err;
      }
    })();
    this.ensureStreamState(streamId).pendingLoad = work;
    try {
      await work;
    } finally {
      const state = this.streams.get(streamId);
      if (state) {
        state.pendingLoad = undefined;
        this.tryRelease(streamId);
      }
    }
  }

  // -- Transcript mutation -------------------------------------------------
  // Row mutation is writer-only (#9590 Stage 5): every mutator below is
  // private and reachable solely through the `TranscriptWriter` closures
  // minted by `acquireWriter`/`loadAndAcquireWriter`, so one logical
  // execution holds mutation authority per stream.

  private appendEntry(
    streamId: StreamTabId,
    entry: StreamLogAppendInput,
    settled: boolean,
  ): StreamLogEntry {
    this.assertWritableStream(streamId);
    if (
      this.mode.kind === 'persistent' &&
      this.summaries.has(streamId) &&
      this.streams.get(streamId)?.log === undefined &&
      this.streams.get(streamId)?.pendingLoad === undefined
    ) {
      throw new Error(
        `Cannot append to released stream ${streamId}. Await ensureLoaded() first.`,
      );
    }
    const state = this.ensureStreamState(streamId);
    let logInstance = state.log;
    if (!logInstance) {
      logInstance = new StreamLog();
      state.log = logInstance;
      if (!this.summaries.has(streamId)) {
        this.summaries.set(streamId, {});
        this.adoptPendingSummaryMeta(streamId);
      }
    }
    const appended = settled
      ? logInstance.appendSettled(entry)
      : logInstance.append(entry);
    this.commitChange(streamId, logInstance);
    this.scheduleSave();
    return appended;
  }

  /**
   * Shared body of the entry mutators: guard writability, resolve the resident
   * log, apply the mutation, and commit only when the log reports a change.
   * The three writer-scoped mutators differ solely in which `StreamLog` method runs.
   */
  private mutateEntry(
    streamId: StreamTabId,
    apply: (log: StreamLog) => StreamLogEntry | undefined,
  ): StreamLogEntry | undefined {
    this.assertWritableStream(streamId);
    const logInstance = this.streams.get(streamId)?.log;
    if (!logInstance) return undefined;

    const updated = apply(logInstance);
    if (!updated) return undefined;

    this.commitChange(streamId, logInstance);
    this.scheduleSave();
    return updated;
  }

  getTimestampRange(streamId: StreamTabId): {
    first: number | undefined;
    last: number | undefined;
  } {
    const residentLog = this.streams.get(streamId)?.log;
    const summary = this.summaries.get(streamId);
    return {
      first: residentLog?.firstTimestamp ?? summary?.firstTimestamp,
      last: residentLog?.lastTimestamp ?? summary?.lastTimestamp,
    };
  }

  async delete(streamId: StreamTabId): Promise<void> {
    this.assertWritableStore('delete a transcript stream');
    this.writeTombstones.add(streamId);
    this.saveThrottle.cancel();

    try {
      await this.executeWrite();
      if (this.mode.kind !== 'ephemeral') {
        log.info(`Deleting stream: ${streamId}`);
        await this.kv().delete(streamId);
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
      if (this.streams.get(streamId)?.log !== undefined)
        this.markDirty(streamId);
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
    this.saveThrottle.cancel();
    this.forgetAllStreamState();
    this.stateRevision += 1;

    try {
      await this.writeQueue.onIdle();
      this.forgetAllStreamState();
      if (this.mode.kind === 'ephemeral') return;

      log.info(`Clearing all ${count} streams`);
      await this.kv().deleteDir();
      await this.clearSummaryCache();
    } finally {
      this.writeTombstones.clear();
      this.clearing = false;
    }
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
        this.needsReload(id) && hasSomethingRunning(this.summaries.get(id)),
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
      this.scheduleSave();
    }
    // Preserve logs that were resident before this call; only release the
    // cold logs loaded specifically for recovery.
    for (const streamId of streamsToLoad) {
      this.requestEviction(streamId);
    }

    return affected;
  }

  private endRunningEntriesInLoadedLogs(
    now: number,
    streamIds: ReadonlySet<StreamTabId>,
    status: RunOutcome,
  ): StreamTabId[] {
    const affected: StreamTabId[] = [];
    for (const [streamId, state] of this.streams) {
      const logInstance = state.log;
      if (!logInstance) continue;
      if (!streamIds.has(streamId)) continue;
      let updatedAny = false;
      for (const entry of logInstance.getRange(0, logInstance.head)) {
        if (isRunningGroupEntry(entry)) {
          const existingData = isObject(entry.data) ? entry.data : {};
          const updated = logInstance.settle(entry.id, {
            type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
            data: { ...existingData, status, endTime: now },
          });
          if (updated) updatedAny = true;
          continue;
        }

        // A thinking/scratchpad/model-response stream that never got a
        // `stream.end` (run cancelled/crashed/reloaded mid-stream) — finalize
        // it so it renders as its normal completed banner instead of being
        // stuck rendering as an in-progress entry forever (#7276).
        if (isRunningStreamingTextEntry(entry)) {
          const existingData = isObject(entry.data) ? entry.data : {};
          const updated = logInstance.settle(entry.id, {
            data: { ...existingData, status: 'completed' },
          });
          if (updated) updatedAny = true;
          continue;
        }

        const call = nonterminalWorkflowCall(entry);
        if (call) {
          const recoveredCall =
            call.status === 'planned'
              ? {
                  ...call,
                  status: 'skipped' as const,
                  reason: 'not-reached' as const,
                }
              : {
                  ...call,
                  status: 'failed' as const,
                  error:
                    'The previous host stopped before this call completed.',
                };
          const updated = logInstance.settle(entry.id, {
            level: call.status === 'planned' ? 'info' : 'error',
            data: recoveredCall,
          });
          if (updated) updatedAny = true;
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
   * `discardPendingWrites` is reserved for workspace-root rollback after the
   * old root was already flushed; it prevents failed new-root repair state
   * from being written after the provider returns to the old root.
   */
  async reload(
    options: { readonly discardPendingWrites?: boolean } = {},
  ): Promise<void> {
    if (this.mode.kind === 'ephemeral') {
      throw new Error(
        `Cannot reload an ephemeral transcript store (${this.mode.reason}).`,
      );
    }
    if (this.pendingReload) return this.pendingReload;

    const work = this.executeReload(options.discardPendingWrites ?? false);
    this.pendingReload = work;
    try {
      await work;
    } finally {
      if (this.pendingReload === work) this.pendingReload = undefined;
    }
  }

  /**
   * Throttled internal persistence trigger; every mutator schedules it.
   * Fire-and-forget by design: only `flush()` is awaitable, and it drains,
   * retries, and throws.
   */
  private scheduleSave(): void {
    this.assertWritableStore('save transcripts');
    if (this.mode.kind === 'ephemeral' || this.dirtyIds.size === 0) return;
    // Throttle, not debounce: only start a window when none is open, so a
    // sustained stream of mutations cannot keep pushing the write out.
    if (!this.saveThrottle.pending) this.saveThrottle.schedule();
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
      const loads = this.pendingLoads();
      if (this.saveThrottle.pending) {
        this.saveThrottle.cancel();
        await this.executeWrite();
        writeAttempts++;
      } else if (this.writeQueue.size > 0 || this.writeQueue.pending > 0) {
        await this.writeQueue.onIdle();
      } else if (loads.length > 0) {
        await Promise.allSettled(loads);
      } else {
        // No in-flight work. Decide whether anything deferred can still
        // be persisted in another save cycle.
        const dirty = this.dirtyStreamIds();
        const canRetry = dirty.some(
          (id) => this.streams.get(id)?.loadFailed !== true,
        );
        if (!canRetry) {
          if (dirty.length > 0) {
            throw new Error(
              `Cannot flush ${dirty.length} stream(s) whose persisted transcripts failed to load.`,
            );
          }
          return;
        }
        if (writeAttempts >= MAX_WRITE_RETRIES) {
          throw new Error(
            `Transcript flush failed after ${MAX_WRITE_RETRIES} retries; ` +
              `${dirty.length} stream(s) remain dirty.`,
          );
        }
        await this.executeWrite();
        writeAttempts++;
      }
    }
  }

  private assertWritableStream(streamId: StreamTabId): void {
    this.assertWritableStore('modify transcript entries');
    if (this.streams.get(streamId)?.loadFailed !== true) return;
    throw new Error(
      `Cannot modify stream ${streamId} after its persisted transcript failed to load. Retry ensureLoaded() first.`,
    );
  }

  /** Shared post-mutation bookkeeping for append/update/appendText/group-end. */
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
      if (logInstance.hasNonterminalWorkflowCall) {
        existing.hasNonterminalWorkflowCall = true;
      } else {
        delete existing.hasNonterminalWorkflowCall;
      }
    } else {
      this.summaries.set(streamId, toSummary(logInstance));
    }
  }

  private async executeReload(discardPendingWrites: boolean): Promise<void> {
    // Sample before the first await: run facts may arrive while pending writes
    // drain or the replacement adapters prepare, and the reload must not fold
    // those new-root facts into the state it is about to replace.
    const revision = this.stateRevision;
    if (discardPendingWrites) {
      this.saveThrottle.cancel();
      // Invalidate and drain any in-flight batch before the adapters
      // repoint: a write started before a storage-root rollback must not
      // keep landing streams against the restored root. The generation
      // bump makes the batch's remaining per-stream writes skip; the
      // drain keeps a mid-write stream from straddling the repoint.
      this.writeGeneration += 1;
      await this.writeQueue.onIdle();
    } else if (this.mode.kind === 'persistent') {
      await this.flush();
    }
    if (!discardPendingWrites && this.dirtyIds.size > 0) {
      throw new Error(
        'Cannot reload transcripts while persistent writes remain unresolved.',
      );
    }

    // A workspace-root replacement changes what these relative directories
    // resolve to, so the cached KV handles are dropped and re-resolve
    // against the new root on next access, before its first write.
    this.kvHandles.invalidateAll();
    this.summaryCacheMaintenanceEnabled = true;
    if (this.mode.kind === 'persistent') await this.prepareSummaryCache();

    const summaries = await this.readPersistentSummaries();
    if (revision !== this.stateRevision || this.pendingLoads().length > 0) {
      throw new Error(
        'Transcript state changed during reload; preserving the live state.',
      );
    }
    this.replaceSummaries(summaries);
  }

  private async readPersistentSummaries(): Promise<
    Map<StreamTabId, StreamLogSummary>
  > {
    const streamIds = await this.kv().listKeys();
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
    // One clear drops every resident per-stream field (log, leases,
    // loadFailed, pendingLoad, writer). `summaries`, `releaseRequests`,
    // `writeTombstones`, and `dirtyIds` do not share the record's lifecycle
    // and are cleared separately.
    this.streams.clear();
    this.dirtyIds.clear();
    this.releaseRequests.clear();
    this.summaries.clear();
    for (const [streamId, summary] of summaries) {
      this.summaries.set(streamId, summary);
    }
    // Metadata recorded while a stream was unregistered lands now if the
    // replacement set knows the stream (no-op on read-only opens: the
    // antechamber only fills through recordSummaryMeta, which is writable-only).
    // Entries absent from the replacement belong to the previous storage root
    // and are discarded.
    for (const streamId of [...this.pendingSummaryMeta.keys()]) {
      if (this.summaries.has(streamId)) {
        this.adoptPendingSummaryMeta(streamId);
      } else {
        this.pendingSummaryMeta.delete(streamId);
      }
    }
    this.writeTombstones.clear();
    this.clearing = false;
    this.stateRevision += 1;

    log.info(`Loaded ${this.summaries.size} stream summaries (file-backed)`);
  }

  private async loadStreamSummary(
    streamId: StreamTabId,
  ): Promise<StreamLoadResult | null> {
    const persistedSummary = await this.readSummary(streamId);
    if (persistedSummary) {
      return { streamId, summary: persistedSummary };
    }

    const raw = await this.kv().read<unknown[]>(streamId);
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
      const persisted = await this.summaryKv().read<unknown>(streamId);
      const summary = this.parsePersistedSummary(persisted);
      if (!summary) return undefined;

      const [summaryMtime, logMtime] = await Promise.all([
        this.summaryKv().modifiedAt(streamId),
        this.kv().modifiedAt(streamId),
      ]);
      // A missing log mtime means the authoritative log is gone (deleted, or
      // never written) — orphaned summary, not merely stale. Trusting it here
      // would register a stream that has no log to load, so `ensureLoaded`
      // reads back an empty transcript instead of surfacing it as missing.
      if (
        summaryMtime !== undefined &&
        (logMtime === undefined || summaryMtime < logMtime)
      ) {
        return undefined;
      }

      return summary;
    } catch (error) {
      const condition =
        error instanceof SyntaxError ? 'corrupt' : 'unavailable';
      log.warn(
        `Ignoring ${condition} summary cache for ${streamId}; rebuilding from the stream log: ${toErrorMessage(error)}`,
      );
      return undefined;
    }
  }

  private summarizeEntries(
    entries: readonly StreamLogEntry[],
  ): StreamLogSummary {
    return toSummary({
      firstTimestamp: entries[0]?.timestamp,
      lastTimestamp: entries.at(-1)?.timestamp,
      hasRunningGroup: entries.some(isRunningGroupEntry),
      hasRunningStreamingText: entries.some(isRunningStreamingTextEntry),
      hasNonterminalWorkflowCall: entries.some(
        (entry) => nonterminalWorkflowCall(entry) !== undefined,
      ),
    });
  }

  private parsePersistedSummary(value: unknown): StreamLogSummary | undefined {
    // A missing cache file (KVStore's quiet-missing `undefined`) is an
    // ordinary rebuild, not a stale shape — nothing to warn about.
    if (value === undefined) return undefined;
    const result = StreamLogSummarySchema.safeParse(value);
    if (!result.success) {
      // Derived tier (#9434): discard the stale-shaped cache loudly and
      // rebuild from the authoritative stream log — never migrate in place.
      log.warn(
        `Discarding a stale-shaped summary cache entry; rebuilding from the stream log: ${result.error.issues
          .map(
            (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
          )
          .join('; ')}`,
      );
      return undefined;
    }
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
    await this.kv().write(streamId, logInstance.toPersistedEntries());
    if (this.shouldSkipWrite(streamId, expectedGeneration)) {
      await this.kv().delete(streamId);
      await this.deleteSummaryCache(streamId);
      return;
    }

    // Carry the snapshot-owned `meta` block forward: `toSummary` only knows
    // log-derived fields, and persisting it bare would strip the metadata
    // mirror `recordSummaryMeta` last wrote for this stream.
    const meta = this.summaries.get(streamId)?.meta;
    await this.maintainSummaryCache(streamId, {
      ...toSummary(logInstance),
      ...(meta !== undefined && { meta }),
    });
    if (this.shouldSkipWrite(streamId, expectedGeneration)) {
      await this.kv().delete(streamId);
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
    // Dropping the record removes every resident field for this stream at
    // once. `summaries` (a separate registry) and `dirtyIds` (the separate
    // dirtiness set) are cleared here too; the in-flight `writeTombstones`
    // guard is intentionally left untouched — its lifetime is owned by
    // `delete()`'s try/finally, not by this cascade.
    this.streams.delete(streamId);
    this.dirtyIds.delete(streamId);
    this.releaseRequests.delete(streamId);
    this.summaries.delete(streamId);
    this.pendingSummaryMeta.delete(streamId);
  }

  private forgetAllStreamState(): void {
    // Same single-drop as `forgetStreamState`, store-wide. `writeTombstones`
    // is deliberately not cleared here — `clear()` owns and clears it in its
    // own finally block.
    this.streams.clear();
    this.dirtyIds.clear();
    this.releaseRequests.clear();
    this.summaries.clear();
    this.pendingSummaryMeta.clear();
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
      await this.summaryKv().write(streamId, summary);
    } catch (error) {
      this.disableSummaryCacheMaintenance(
        `Failed to write transcript summary cache for ${streamId}: ${toErrorMessage(error)}`,
      );
    }
  }

  private async deleteSummaryCache(streamId: StreamTabId): Promise<void> {
    if (!this.summaryCacheMaintenanceEnabled) return;
    try {
      await this.summaryKv().delete(streamId);
    } catch (error) {
      this.disableSummaryCacheMaintenance(
        `Failed to delete transcript summary cache for ${streamId}: ${toErrorMessage(error)}`,
      );
    }
  }

  private async clearSummaryCache(): Promise<void> {
    if (!this.summaryCacheMaintenanceEnabled) return;
    try {
      await this.summaryKv().deleteDir();
    } catch (error) {
      this.disableSummaryCacheMaintenance(
        `Failed to clear transcript summary cache: ${toErrorMessage(error)}`,
      );
    }
  }

  private disableSummaryCacheMaintenance(message: string): void {
    if (!this.summaryCacheMaintenanceEnabled) return;
    this.summaryCacheMaintenanceEnabled = false;
    log.warn(message);
  }

  private markDirty(streamId: StreamTabId): void {
    // Callers always hold a resident record for this stream (a fresh log, a
    // merge, or a deferred loadFailed/pendingLoad record), so dirtiness only
    // needs to be recorded in the set — see the `dirtyIds` field note.
    this.dirtyIds.add(streamId);
    this.acquireLease(streamId, 'flush');
  }

  private acquireLease(
    streamId: StreamTabId,
    reason: TranscriptResidencyLeaseReason,
  ): void {
    const state = this.ensureStreamState(streamId);
    state.leases ??= new Set();
    state.leases.add(reason);
  }

  private releaseLease(
    streamId: StreamTabId,
    reason: TranscriptResidencyLeaseReason,
  ): void {
    const state = this.streams.get(streamId);
    if (!state) return;
    state.leases?.delete(reason);
    if (state.leases?.size === 0) state.leases = undefined;
    this.tryRelease(streamId);
    this.pruneStreamState(streamId);
  }

  private tryRelease(streamId: StreamTabId): void {
    if (this.mode.kind === 'ephemeral') return;
    const state = this.streams.get(streamId);
    if (
      !state ||
      !this.releaseRequests.has(streamId) ||
      (state.leases?.size ?? 0) > 0 ||
      (state.presentationLeases?.size ?? 0) > 0 ||
      this.dirtyIds.has(streamId) ||
      state.pendingLoad
    ) {
      return;
    }
    if (state.log) {
      this.refreshSummary(streamId, state.log);
      state.log = undefined;
      this.stateRevision += 1;
    }
    this.pruneStreamState(streamId);
  }

  /**
   * Drain the log's pending entry-level changes into one immutable delta and
   * multicast it. The delta is drained exactly once per notification and
   * shared by every listener; no listener acks anything and nothing here is
   * destructive — this is the single change-feed surface, and consumers that
   * miss or lose a delta resync from `getRange(0)`.
   */
  private notify(
    streamId: StreamTabId,
    options: { readonly reset?: boolean } = {},
  ): void {
    const logInstance = this.streams.get(streamId)?.log;
    if (!logInstance) return;
    const delta: StreamLogDelta = Object.freeze({
      ...logInstance.drainEmission(),
      reset: options.reset === true,
    });
    for (const listener of this.listeners) {
      listener(streamId, delta);
    }
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
      const result = StreamLogEntrySchema.safeParse(raw);
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
        `Stream ${streamId}: ${formatResultCount(count, 'persisted transcript entry')} did not parse; ` +
          `preserving raw for round-trip on save.`,
      );
    }

    return parsed;
  }

  private executeWrite(): Promise<void> {
    // One batch at a time: a save window that fires while a batch is still
    // writing queues behind it, so two batches can never interleave `kv`
    // writes for the same stream (the later batch could otherwise persist
    // the older snapshot last). The batch snapshots `dirtyIds` when it
    // starts, so a queued batch picks up mutations made during its
    // predecessor; a batch that finds nothing dirty is a no-op.
    return this.writeQueue.add(() => this.runWriteBatch());
  }

  private async runWriteBatch(): Promise<void> {
    // Skip streams whose rehydrate is pending or errored — writing now
    // would clobber the authoritative on-disk history with a fresh
    // empty-plus-new-appends log before `ensureLoaded` merges disk entries
    // back in. Keep them dirty so the next save retries after the load
    // resolves.
    const allDirty = this.dirtyStreamIds();
    this.dirtyIds.clear();
    const toWrite: StreamTabId[] = [];
    for (const streamId of allDirty) {
      const state = this.streams.get(streamId);
      if (state?.loadFailed || state?.pendingLoad !== undefined) {
        this.markDirty(streamId);
      } else {
        toWrite.push(streamId);
      }
    }

    if (toWrite.length === 0) return;

    log.debug(`Writing ${toWrite.length} dirty stream(s)`);
    const writeGeneration = this.writeGeneration;

    // Write streams one at a time. Each KV write serializes the stream's full
    // transcript to JSON before the filesystem await; starting every dirty
    // stream together retains all of those large JSON strings simultaneously.
    // Sequential writes keep peak memory proportional to one serialized
    // transcript while preserving independent per-stream failure handling.
    try {
      for (const streamId of toWrite) {
        const logInstance = this.streams.get(streamId)?.log;
        if (!logInstance) continue;
        try {
          await this.writeStream(streamId, logInstance, writeGeneration);
        } catch {
          // Failed writes re-mark their stream dirty so the next save retries.
          // Continue draining the batch so one unavailable file does not
          // prevent unrelated transcripts from becoming durable.
          if (this.streams.get(streamId)?.log !== undefined)
            this.markDirty(streamId);
        }
      }
    } finally {
      for (const streamId of toWrite) {
        const state = this.streams.get(streamId);
        if (state && !this.dirtyIds.has(streamId))
          this.releaseLease(streamId, 'flush');
      }
    }
  }
}
