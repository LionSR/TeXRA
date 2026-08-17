import { randomUUID } from 'node:crypto';
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
  STREAM_PHASE,
  RunIdentitySchema,
  STREAM_LOG_ENTRY_TYPES,
  StreamLogEntrySchema,
  UserFollowUpSupportSchema,
  type RunOutcome,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';
import { filterNotNull, isObject } from '@utils/core';
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

export const STREAM_LOGS_DIR = WORKSPACE_STORAGE_LAYOUT.streamLogs;
// Temporary one-shot reader/cleanup for the retired derived summary tier.
// Introduced 2026-08-17; remove after 2026-11-17.
const LEGACY_STREAM_LOG_SUMMARIES_DIR = 'streamLogSummaries';
const STREAM_LOG_LOAD_CONCURRENCY = 8;
const STREAM_LOG_CHECKPOINT_TAIL_BYTES = 64 * 1024;
const STREAM_LOG_JOURNAL_EXTENSION = '.jsonl';
const STREAM_LOG_JOURNAL_VERSION = 1;
const LOG_TAG = 'StreamLogStore';
const log = createLog(LOG_TAG);

type StreamLogListener = (streamId: StreamTabId, delta: StreamLogDelta) => void;

/**
 * Snapshot-owned display metadata mirrored into the always-resident summary,
 * so sidebars and all-streams metadata paths never read the per-stream
 * sidecar files (#9947, PRD 2026-08-11). `StreamSnapshotStore` is the
 * authority and publishes a whole replacement object on every metadata
 * mutation and on every sidecar hydration. The canonical transcript journal
 * carries it in checkpoint records. Bounded scalars only:
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

// No per-field `.catch()`: malformed legacy summary metadata must be rejected
// as a unit instead of silently dropping crash-recovery flags or metadata.
// Current summary flags are always derived from authoritative journal rows.
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
  preserveLegacySummary?: boolean;
  loadFailed?: boolean;
}

interface PersistentSummaryScan {
  summaries: Map<StreamTabId, StreamLogSummary>;
  failedStreams: Set<StreamTabId>;
  canCleanupLegacySummaries: boolean;
}

interface ParsedPersistedEntries {
  entries: StreamLogEntry[];
  preservedRawEntries: StreamLogPreservedRawEntry[];
  summaryCheckpointSeen?: boolean;
  summaryMeta?: StreamSummaryMeta;
}

const StreamLogJournalRecordSchema = z.discriminatedUnion('op', [
  z.object({
    version: z.literal(STREAM_LOG_JOURNAL_VERSION),
    opId: z.uuid(),
    op: z.literal('seed'),
    entries: z.array(z.unknown()),
  }),
  z.object({
    version: z.literal(STREAM_LOG_JOURNAL_VERSION),
    opId: z.uuid(),
    op: z.literal('ensure'),
  }),
  z.object({
    version: z.literal(STREAM_LOG_JOURNAL_VERSION),
    opId: z.uuid(),
    op: z.literal('append'),
    entry: StreamLogEntrySchema,
    settled: z.boolean(),
  }),
  z.object({
    version: z.literal(STREAM_LOG_JOURNAL_VERSION),
    opId: z.uuid(),
    op: z.literal('update'),
    id: z.string().min(1),
    patch: z.looseObject({}),
    settled: z.boolean(),
  }),
  z.object({
    version: z.literal(STREAM_LOG_JOURNAL_VERSION),
    opId: z.uuid(),
    op: z.literal('checkpoint'),
    summary: StreamLogSummarySchema,
  }),
]);
type StreamLogJournalRecord = z.infer<typeof StreamLogJournalRecordSchema>;
type StreamLogJournalRecordInput =
  | { readonly op: 'ensure' }
  | { readonly op: 'seed'; readonly entries: readonly unknown[] }
  | {
      readonly op: 'append';
      readonly entry: StreamLogEntry;
      readonly settled: boolean;
    }
  | {
      readonly op: 'update';
      readonly id: string;
      readonly patch: StreamLogUpdatePatch;
      readonly settled: boolean;
    }
  | { readonly op: 'checkpoint'; readonly summary: StreamLogSummary };

interface ParsedJsonlRecords {
  readonly entries: unknown[];
  readonly repairedText?: string;
}

/** Parse independent records and isolate corrupt or torn lines loudly. */
function parseJsonlEntries(
  streamId: StreamTabId,
  raw: string,
): ParsedJsonlRecords {
  const lines = raw.split('\n');
  const entries: unknown[] = [];
  let repairedText: string | undefined;
  for (const [index, line] of lines.entries()) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      const tornTail = index === lines.length - 1 && !raw.endsWith('\n');
      log.warn(
        `Stream ${streamId}: ignoring ${tornTail ? 'torn final' : 'malformed'} journal line ${index + 1}: ${toErrorMessage(error)}`,
      );
      if (tornTail) repairedText = lines.slice(0, index).join('\n') + '\n';
    }
  }
  if (raw.length > 0 && !raw.endsWith('\n') && repairedText === undefined) {
    repairedText = `${raw}\n`;
  }
  return { entries, ...(repairedText !== undefined ? { repairedText } : {}) };
}

function toJournalRecord(
  record: StreamLogJournalRecordInput,
): StreamLogJournalRecord {
  return {
    version: STREAM_LOG_JOURNAL_VERSION,
    opId: randomUUID(),
    ...record,
  } as StreamLogJournalRecord;
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
  readonly settlementHead: number;
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
  /** Completion of the latest queued non-resident `readEntries` read. */
  pendingRead?: Promise<void>;
  /** Exact mutation capabilities currently keeping a stream resident. */
  writer?: StreamWriterOwnership;
  /** Unflushed append-only records, retained until their exact prefix lands. */
  journalRecords?: StreamLogJournalRecord[];
  /** A failed append may have left a torn tail that must be repaired first. */
  journalNeedsTailRepair?: boolean;
  /** Current task in the per-stream persistence queue. */
  persistenceWork?: Promise<void>;
  /** A derived checkpoint must follow the pending journal prefix. */
  summaryDirty?: boolean;
  /** Last asynchronous persistence error, surfaced and retried by flush(). */
  persistenceError?: unknown;
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

function parsePersistedUpdate(
  current: StreamLogEntry,
  patch: Record<string, unknown>,
): StreamLogUpdatePatch | undefined {
  const mergedData =
    current.type === STREAM_LOG_ENTRY_TYPES.GROUP_START &&
    patch.type === STREAM_LOG_ENTRY_TYPES.GROUP_END &&
    isObject(patch.data)
      ? { ...current.data, ...patch.data }
      : patch.data;
  const result = StreamLogEntrySchema.safeParse({
    ...current,
    ...patch,
    ...(mergedData !== undefined ? { data: mergedData } : {}),
    id: current.id,
    seqNo: current.seqNo,
    ...(current.settlementSeqNo !== undefined
      ? { settlementSeqNo: current.settlementSeqNo }
      : {}),
  });
  if (!result.success) return undefined;
  const {
    id: _id,
    seqNo: _seqNo,
    settlementSeqNo: _settlementSeqNo,
    ...validatedPatch
  } = result.data;
  return validatedPatch;
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
  let normalized = entry;
  switch (entry.data.status) {
    case END_GROUP_STATUS.STOPPED:
      normalized = {
        ...entry,
        data: { ...entry.data, status: RUN_OUTCOME.COMPLETED },
      };
      break;
    case END_GROUP_STATUS.ERROR:
      normalized = {
        ...entry,
        data: { ...entry.data, status: RUN_OUTCOME.FAILED },
      };
      break;
  }

  // Temporary reader introduced 2026-08-17 for pre-#10774 logs. Group-start
  // rows used to allocate settlement order while still running, so recovery
  // must first restore them to the canonical mutable shape before it can
  // terminalize them through StreamLog.settle(). Retire after 2026-11-17,
  // when those internal logs are outside the compatibility window.
  if (
    normalized.type === STREAM_LOG_ENTRY_TYPES.GROUP_START &&
    normalized.data.status === STREAM_PHASE.RUNNING &&
    normalized.settlementSeqNo !== undefined
  ) {
    const { settlementSeqNo: legacySettlement, ...unsettled } = normalized;
    return {
      ...unsettled,
      presentationSeqNo: unsettled.presentationSeqNo ?? legacySettlement,
    } as StreamLogEntry;
  }
  return normalized;
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
   * {@link StreamState}. `summaries` and `writeTombstones` are deliberately
   * kept separate because they do not share this lifecycle.
   */
  private readonly streams = new ResidentStreamRegistry<
    StreamTabId,
    StreamState
  >(() => ({}));
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
  /** One serial queue per active stream; different streams remain independent. */
  private readonly persistenceQueues = new Map<StreamTabId, PQueue>();

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

  private writeGeneration = 0;
  private readonly writeTombstones = new Set<StreamTabId>();
  private clearing = false;
  private stateRevision = 0;
  private pendingReload: Promise<void> | undefined;

  private constructor(mode: StreamLogStoreMode) {
    this.mode = Object.freeze(mode);
  }

  /** Handle over `STREAM_LOGS_DIR`; re-resolved after a storage-root reload. */
  private kv(): KVStore {
    return this.kvHandles.get(STREAM_LOGS_DIR);
  }

  private persistenceQueue(streamId: StreamTabId): PQueue {
    let queue = this.persistenceQueues.get(streamId);
    if (!queue) {
      queue = new PQueue({ concurrency: 1 });
      this.persistenceQueues.set(streamId, queue);
    }
    return queue;
  }

  private async runInPersistenceQueue<T>(
    streamId: StreamTabId,
    task: () => Promise<T>,
  ): Promise<T> {
    const queue = this.persistenceQueue(streamId);
    try {
      return (await queue.add(task)) as T;
    } finally {
      if (
        queue.pending === 0 &&
        queue.size === 0 &&
        this.persistenceQueues.get(streamId) === queue
      ) {
        this.persistenceQueues.delete(streamId);
      }
    }
  }

  /** Temporary reader for the retired summary sidecar directory. */
  private legacySummaryKv(): KVStore {
    return this.kvHandles.get(LEGACY_STREAM_LOG_SUMMARIES_DIR);
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
   * no memory.
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
        s.pendingRead === undefined &&
        s.writer === undefined &&
        !s.journalNeedsTailRepair &&
        (s.journalRecords === undefined || s.journalRecords.length === 0) &&
        s.persistenceWork === undefined &&
        !s.summaryDirty &&
        s.persistenceError === undefined,
    );
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
    const scan = await store.readPersistentSummaries();
    store.replaceSummaries(scan.summaries, scan.failedStreams);
    if (scan.canCleanupLegacySummaries) {
      await store.cleanupLegacySummaryCache();
    }
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
    if (this.pendingReload) await this.pendingReload;
    if (this.clearing || this.writeTombstones.has(streamId)) return [];
    const resident = this.streams.get(streamId)?.log;
    if (resident) return resident.toJSON();
    if (this.mode.kind === 'ephemeral' || !this.summaries.has(streamId)) {
      return [];
    }
    const parsed = await this.readPersistedEntries(streamId);
    if (!parsed) return [];
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
    return this.hasPersistedStream(streamId);
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
   * or `undefined` for a stream whose journal predates metadata checkpoints.
   * Metadata recorded
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
   * always-resident summary (memory now, journal checkpoint asynchronously).
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
    // A failed authoritative read keeps the registry entry visible, but no
    // write may race an explicit rehydrate retry and overwrite that log.
    if (
      this.mode.kind === 'persistent' &&
      this.streams.get(streamId)?.loadFailed !== true
    ) {
      this.markPersistentChange(streamId);
    }
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
    this.queueJournalRecord(streamId, toJournalRecord({ op: 'ensure' }));
    this.summaries.set(streamId, {});
    this.adoptPendingSummaryMeta(streamId);
    this.stateRevision += 1;
    if (this.mode.kind === 'persistent') {
      this.markPersistentChange(streamId);
    }
  }

  /**
   * Drop heavy entries from memory while keeping the on-disk copy authoritative.
   * If there are pending writes, queue the release so `persistStream` can flush
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
      get settlementHead() {
        assertOwned();
        return writerState.log?.settlementHead ?? 0;
      },
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
        return this.mutateEntry(
          streamId,
          (log) => log.update(id, patch),
          () => toJournalRecord({ op: 'update', id, patch, settled: false }),
        );
      },
      settle: (id, patch) => {
        assertOwned();
        return this.mutateEntry(
          streamId,
          (log) => log.settle(id, patch),
          (updated) => {
            // Chunk updates are intentionally memory-only. Settlement must
            // persist the fully materialized entry, including accumulated text.
            const {
              id: _id,
              seqNo: _seqNo,
              settlementSeqNo: _settlementSeqNo,
              ...settledPatch
            } = updated;
            return toJournalRecord({
              op: 'update',
              id,
              patch: settledPatch,
              settled: true,
            });
          },
        );
      },
      appendText: (id, text) => {
        assertOwned();
        // Streaming text remains in the recorder's bounded in-memory window.
        // Only the whole-buffer redacted settle patch is durable: persisting
        // independently redacted chunks could retain a secret split across
        // chunk boundaries forever in the append-only file.
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
    let recoveredFromLoad = false;
    const work = (async () => {
      try {
        // If `delete` or `clear` ran during the read, don't resurrect it.
        if (
          this.clearing ||
          this.writeTombstones.has(streamId) ||
          !this.summaries.has(streamId)
        ) {
          return;
        }
        const diskEntries = await this.readPersistedEntries(streamId);
        if (!diskEntries) return;
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
          this.markPersistentChange(streamId);
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
        // by persistStream), flush it now so we don't wait for another
        // append to unblock it.
        const recovered = this.streams.get(streamId);
        if (recovered) recovered.loadFailed = false;
        recoveredFromLoad = true;
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
        if (recoveredFromLoad && this.hasPendingPersistence(streamId)) {
          this.schedulePersistence(streamId);
        }
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
    this.queueJournalRecord(
      streamId,
      toJournalRecord({ op: 'append', entry: appended, settled }),
    );
    this.commitChange(streamId, logInstance, true);
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
    journalRecord?: (updated: StreamLogEntry) => StreamLogJournalRecord,
  ): StreamLogEntry | undefined {
    this.assertWritableStream(streamId);
    const logInstance = this.streams.get(streamId)?.log;
    if (!logInstance) return undefined;

    const updated = apply(logInstance);
    if (!updated) return undefined;

    if (journalRecord) {
      this.queueJournalRecord(streamId, journalRecord(updated));
    }
    this.commitChange(streamId, logInstance, journalRecord !== undefined);
    return updated;
  }

  private queueJournalRecord(
    streamId: StreamTabId,
    record: StreamLogJournalRecord,
  ): void {
    if (this.mode.kind !== 'persistent') return;
    const state = this.ensureStreamState(streamId);
    state.journalRecords ??= [];
    state.journalRecords.push(record);
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

    try {
      const state = this.streams.get(streamId);
      const pending = [
        state?.pendingLoad,
        state?.pendingRead,
        state?.persistenceWork,
      ].filter((work): work is Promise<void> => work !== undefined);
      if (pending.length > 0) await Promise.allSettled(pending);
      if (this.mode.kind !== 'ephemeral') {
        log.info(`Deleting stream: ${streamId}`);
        await this.kv().delete(streamId);
        await this.kv().deleteWithExtension(
          streamId,
          STREAM_LOG_JOURNAL_EXTENSION,
        );
        await this.deleteLegacySummaryEntry(streamId);
      }
      // The summaries map is the progress tab registry. Commit its removal
      // only after durable deletion succeeds so callers can retain and retry a
      // stream whose transcript cleanup failed.
      this.forgetStreamState(streamId);
      this.stateRevision += 1;
    } finally {
      this.writeTombstones.delete(streamId);
    }
  }

  async clear(): Promise<void> {
    this.assertWritableStore('clear transcript streams');
    const count = this.summaries.size;
    this.clearing = true;
    this.writeGeneration += 1;
    this.stateRevision += 1;

    try {
      const pending = [...this.streams.values()].flatMap((state) =>
        [state.pendingLoad, state.pendingRead, state.persistenceWork].filter(
          (work): work is Promise<void> => work !== undefined,
        ),
      );
      await Promise.allSettled(pending);
      this.forgetAllStreamState();
      if (this.mode.kind === 'ephemeral') return;

      log.info(`Clearing all ${count} streams`);
      await this.kv().deleteDir();
      await this.cleanupLegacySummaryCache();
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
          const patch = {
            type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
            data: { ...existingData, status, endTime: now },
          } satisfies StreamLogUpdatePatch;
          const updated = logInstance.settle(entry.id, patch);
          if (updated) {
            this.queueJournalRecord(
              streamId,
              toJournalRecord({
                op: 'update',
                id: entry.id,
                patch,
                settled: true,
              }),
            );
            updatedAny = true;
          }
          continue;
        }

        // A thinking/scratchpad/model-response stream that never got a
        // `stream.end` (run cancelled/crashed/reloaded mid-stream) — finalize
        // it so it renders as its normal completed banner instead of being
        // stuck rendering as an in-progress entry forever (#7276).
        if (isRunningStreamingTextEntry(entry)) {
          const existingData = isObject(entry.data) ? entry.data : {};
          const patch = {
            data: { ...existingData, status: 'completed' },
          } satisfies StreamLogUpdatePatch;
          const updated = logInstance.settle(entry.id, patch);
          if (updated) {
            this.queueJournalRecord(
              streamId,
              toJournalRecord({
                op: 'update',
                id: entry.id,
                patch,
                settled: true,
              }),
            );
            updatedAny = true;
          }
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
          const patch = {
            level: call.status === 'planned' ? 'info' : 'error',
            data: recoveredCall,
          } satisfies StreamLogUpdatePatch;
          const updated = logInstance.settle(entry.id, patch);
          if (updated) {
            this.queueJournalRecord(
              streamId,
              toJournalRecord({
                op: 'update',
                id: entry.id,
                patch,
                settled: true,
              }),
            );
            updatedAny = true;
          }
        }
      }

      if (updatedAny) {
        affected.push(streamId);
        this.commitChange(streamId, logInstance, true);
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

  private hasPendingPersistence(streamId: StreamTabId): boolean {
    const state = this.streams.get(streamId);
    return (
      (state?.journalRecords?.length ?? 0) > 0 || state?.summaryDirty === true
    );
  }

  /** Start one stream's append chain immediately; `flush()` is the error gate. */
  private schedulePersistence(streamId: StreamTabId): void {
    this.assertWritableStore('save transcripts');
    if (this.mode.kind !== 'persistent') return;
    const state = this.ensureStreamState(streamId);
    if (
      state.pendingLoad ||
      state.persistenceWork ||
      !this.hasPendingPersistence(streamId)
    )
      return;
    state.persistenceError = undefined;
    const expectedGeneration = this.writeGeneration;
    const queue = this.persistenceQueue(streamId);
    const task = queue.add(() =>
      this.persistStream(streamId, expectedGeneration),
    );
    const work = Promise.allSettled([task, queue.onIdle()]).then(
      ([taskResult]) => {
        if (taskResult.status === 'rejected') throw taskResult.reason;
      },
    );
    state.persistenceWork = work;
    void work
      .catch((error: unknown) => {
        const current = this.streams.get(streamId);
        if (current) current.persistenceError = error;
      })
      .finally(() => {
        const current = this.streams.get(streamId);
        if (!current || current.persistenceWork !== work) return;
        current.persistenceWork = undefined;
        if (
          queue.pending === 0 &&
          queue.size === 0 &&
          this.persistenceQueues.get(streamId) === queue
        ) {
          this.persistenceQueues.delete(streamId);
        }
        if (
          current.persistenceError === undefined &&
          expectedGeneration === this.writeGeneration &&
          !this.shouldSkipWrite(streamId, expectedGeneration) &&
          this.hasPendingPersistence(streamId)
        ) {
          this.schedulePersistence(streamId);
          return;
        }
        if (!this.hasPendingPersistence(streamId)) {
          this.releaseLease(streamId, 'flush');
        }
      });
  }

  async flush(): Promise<void> {
    this.assertWritableStore('flush transcripts');
    if (this.mode.kind === 'ephemeral') return;

    const MAX_WRITE_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_WRITE_RETRIES; attempt += 1) {
      const loads = this.pendingLoads();
      if (loads.length > 0) await Promise.allSettled(loads);

      const loadFailures: Error[] = [];
      for (const [streamId, state] of this.streams) {
        if (this.shouldSkipWrite(streamId, this.writeGeneration)) continue;
        if (state.loadFailed && this.hasPendingPersistence(streamId)) {
          loadFailures.push(
            new Error(
              `Cannot flush stream ${streamId} because its persisted transcript failed to load.`,
            ),
          );
          continue;
        }
        if (this.hasPendingPersistence(streamId)) {
          this.schedulePersistence(streamId);
        }
      }

      const work = [...this.streams.values()].flatMap((state) =>
        state.persistenceWork ? [state.persistenceWork] : [],
      );
      await Promise.allSettled(work);
      const pending = [...this.streams]
        .filter(
          ([streamId]) =>
            !this.shouldSkipWrite(streamId, this.writeGeneration) &&
            this.streams.get(streamId)?.loadFailed !== true &&
            this.hasPendingPersistence(streamId),
        )
        .map(([streamId]) => streamId);
      if (pending.length === 0) {
        if (loadFailures.length > 0) {
          throw new AggregateError(
            loadFailures,
            `Transcript flush skipped ${loadFailures.length} stream(s) whose persisted transcript failed to load.`,
          );
        }
        return;
      }
      if (attempt === MAX_WRITE_RETRIES) {
        const errors = [
          ...loadFailures,
          ...[...this.streams.values()].flatMap((state) =>
            state.persistenceError === undefined
              ? []
              : [state.persistenceError],
          ),
        ];
        throw new AggregateError(
          errors,
          `Transcript flush failed after ${MAX_WRITE_RETRIES} retries; ${pending.length} stream(s) remain pending.`,
        );
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
  private commitChange(
    streamId: StreamTabId,
    logInstance: StreamLog,
    persist: boolean,
  ): void {
    this.assertWritableStore('commit transcript changes');
    this.refreshSummary(streamId, logInstance);
    this.stateRevision += 1;
    if (persist && this.mode.kind === 'persistent') {
      this.markPersistentChange(streamId);
    }
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
    let revision = this.stateRevision;
    if (discardPendingWrites) {
      // Invalidate and drain any in-flight batch before the adapters
      // repoint: a write started before a storage-root rollback must not
      // keep landing streams against the restored root. The generation
      // bump makes the batch's remaining per-stream writes skip; the
      // drain keeps a mid-write stream from straddling the repoint.
      this.writeGeneration += 1;
      const pending = [...this.streams.values()].flatMap((state) =>
        [state.pendingLoad, state.pendingRead, state.persistenceWork].filter(
          (work): work is Promise<void> => work !== undefined,
        ),
      );
      await Promise.allSettled(pending);
      revision = this.stateRevision;
    } else if (this.mode.kind === 'persistent') {
      await this.flush();
    }
    if (
      !discardPendingWrites &&
      [...this.streams].some(([streamId]) =>
        this.hasPendingPersistence(streamId),
      )
    ) {
      throw new Error(
        'Cannot reload transcripts while persistent writes remain unresolved.',
      );
    }

    // A workspace-root replacement changes what these relative directories
    // resolve to, so the cached KV handles are dropped and re-resolve
    // against the new root on next access, before its first write.
    this.kvHandles.invalidateAll();

    const scan = await this.readPersistentSummaries();
    if (revision !== this.stateRevision || this.pendingLoads().length > 0) {
      throw new Error(
        'Transcript state changed during reload; preserving the live state.',
      );
    }
    this.replaceSummaries(scan.summaries, scan.failedStreams);
    if (this.mode.kind === 'persistent' && scan.canCleanupLegacySummaries) {
      await this.cleanupLegacySummaryCache();
    }
  }

  private async readPersistentSummaries(): Promise<PersistentSummaryScan> {
    const [legacyIds, journalIds, legacySummaryIds] = await Promise.all([
      this.kv().listKeys(),
      this.kv().listKeysWithExtension(STREAM_LOG_JOURNAL_EXTENSION),
      this.legacySummaryKv().listKeys(),
    ]);
    const legacySummaryIdSet = new Set(legacySummaryIds);
    const streamIds = [...new Set([...legacyIds, ...journalIds])];
    const results = await pMap(
      streamIds,
      async (streamId): Promise<StreamLoadResult | null> => {
        const typedStreamId = streamId as StreamTabId;
        try {
          return await this.loadStreamSummary(
            typedStreamId,
            legacySummaryIdSet.has(streamId),
          );
        } catch (error) {
          log.warn(
            `Stream ${streamId}: transcript summary could not be loaded; retaining the stream for an explicit retry: ${toErrorMessage(error)}`,
          );
          return {
            streamId: typedStreamId,
            summary: {},
            loadFailed: true,
            ...(legacySummaryIdSet.has(streamId) && {
              preserveLegacySummary: true,
            }),
          };
        }
      },
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

    return {
      summaries: new Map(
        sortedResults.map(({ streamId, summary }) => [streamId, summary]),
      ),
      failedStreams: new Set(
        sortedResults
          .filter((result) => result.loadFailed)
          .map((result) => result.streamId),
      ),
      canCleanupLegacySummaries: sortedResults.every(
        (result) => !result.preserveLegacySummary,
      ),
    };
  }

  private replaceSummaries(
    summaries: ReadonlyMap<StreamTabId, StreamLogSummary>,
    failedStreams: ReadonlySet<StreamTabId> = new Set(),
  ): void {
    // One clear drops every resident per-stream field (log, leases,
    // loadFailed, pendingLoad, pendingRead, writer). `summaries`, `releaseRequests`,
    // `writeTombstones` does not share the record's lifecycle and is cleared
    // separately.
    this.streams.clear();
    this.releaseRequests.clear();
    this.summaries.clear();
    for (const [streamId, summary] of summaries) {
      this.summaries.set(streamId, summary);
    }
    for (const streamId of failedStreams) {
      this.ensureStreamState(streamId).loadFailed = true;
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
    readLegacyMeta = true,
  ): Promise<StreamLoadResult | null> {
    return this.runInPersistenceQueue(streamId, () =>
      this.loadStreamSummarySerialized(streamId, readLegacyMeta),
    );
  }

  private async loadStreamSummarySerialized(
    streamId: StreamTabId,
    readLegacyMeta: boolean,
  ): Promise<StreamLoadResult | null> {
    // A discovered file may disappear before its read completes. Recheck the
    // union so neither a legacy array nor a journal-only empty registration is
    // resurrected after deletion.
    if (!(await this.hasPersistedStream(streamId))) return null;
    const legacyLogExists = await this.kv().exists(streamId);
    if (!legacyLogExists) {
      const tail = await this.kv().readTextTail(
        streamId,
        STREAM_LOG_JOURNAL_EXTENSION,
        STREAM_LOG_CHECKPOINT_TAIL_BYTES,
      );
      const checkpoint = this.parseTrailingSummaryCheckpoint(tail);
      if (checkpoint) return { streamId, summary: checkpoint };
    }

    const entries = await this.readPersistedEntriesSerialized(streamId);
    if (!entries) return null;
    let legacyMeta = entries.summaryMeta;
    let preserveLegacySummary = false;
    if (!entries.summaryCheckpointSeen && readLegacyMeta) {
      const legacy = await this.readLegacySummaryMeta(streamId);
      legacyMeta = legacy.meta;
      preserveLegacySummary = legacy.readFailed;
    }
    const summary = {
      ...this.summarizeEntries(entries.entries),
      ...(legacyMeta && { meta: legacyMeta }),
    };
    if (
      this.mode.kind === 'persistent' &&
      !entries.summaryCheckpointSeen &&
      legacyMeta !== undefined
    ) {
      const checkpoint = toJournalRecord({ op: 'checkpoint', summary });
      try {
        await this.kv().appendText(
          streamId,
          STREAM_LOG_JOURNAL_EXTENSION,
          `${JSON.stringify(checkpoint)}\n`,
        );
      } catch (error) {
        preserveLegacySummary = true;
        log.warn(
          `Stream ${streamId}: legacy summary checkpoint import failed; retaining the legacy summary for retry: ${toErrorMessage(error)}`,
        );
      }
    }
    return {
      streamId,
      summary,
      ...(preserveLegacySummary && { preserveLegacySummary: true }),
    };
  }

  private parseTrailingSummaryCheckpoint(
    tail: string | undefined,
  ): StreamLogSummary | undefined {
    if (!tail?.endsWith('\n')) return undefined;
    const line = tail.trimEnd().split('\n').at(-1);
    if (!line) return undefined;
    try {
      const parsed = StreamLogJournalRecordSchema.safeParse(JSON.parse(line));
      return parsed.success && parsed.data.op === 'checkpoint'
        ? parsed.data.summary
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async readLegacySummaryMeta(
    streamId: StreamTabId,
  ): Promise<{ meta?: StreamSummaryMeta; readFailed: boolean }> {
    try {
      const persisted = await this.legacySummaryKv().read<unknown>(streamId);
      if (persisted === undefined) return { readFailed: false };
      const parsed = StreamLogSummarySchema.safeParse(persisted);
      if (parsed.success) {
        return {
          ...(parsed.data.meta && { meta: parsed.data.meta }),
          readFailed: false,
        };
      }
      log.warn(
        `Ignoring stale-shaped legacy summary for ${streamId}: ${parsed.error.message}`,
      );
    } catch (error) {
      log.warn(
        `Ignoring unavailable legacy summary for ${streamId}: ${toErrorMessage(error)}`,
      );
      return { readFailed: true };
    }
    return { readFailed: false };
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

  private async persistStream(
    streamId: StreamTabId,
    expectedGeneration: number,
  ): Promise<void> {
    while (!this.shouldSkipWrite(streamId, expectedGeneration)) {
      const state = this.streams.get(streamId);
      if (!state) return;
      const records = state.journalRecords?.slice() ?? [];
      const summary = state.summaryDirty
        ? this.summaries.get(streamId)
        : undefined;
      const checkpoint = summary
        ? toJournalRecord({ op: 'checkpoint', summary: { ...summary } })
        : undefined;
      const recordsToWrite = checkpoint ? [...records, checkpoint] : records;
      if (recordsToWrite.length > 0 && state.journalNeedsTailRepair) {
        const raw = await this.kv().readText(
          streamId,
          STREAM_LOG_JOURNAL_EXTENSION,
        );
        if (raw !== undefined) {
          const parsed = parseJsonlEntries(streamId, raw);
          if (parsed.repairedText !== undefined) {
            await this.kv().writeTextAtomic(
              streamId,
              STREAM_LOG_JOURNAL_EXTENSION,
              parsed.repairedText,
            );
          }
        }
        state.journalNeedsTailRepair = false;
      }
      if (recordsToWrite.length > 0) {
        if (checkpoint) state.summaryDirty = false;
        try {
          await this.kv().appendText(
            streamId,
            STREAM_LOG_JOURNAL_EXTENSION,
            `${recordsToWrite.map((record) => JSON.stringify(record)).join('\n')}\n`,
          );
        } catch (error) {
          state.journalNeedsTailRepair = true;
          if (checkpoint) state.summaryDirty = true;
          throw error;
        }
        // Mutations can queue records while the append is in flight. Remove
        // only the durable prefix; the loop picks up the remainder.
        state.journalRecords?.splice(0, records.length);
      }

      if (this.shouldSkipWrite(streamId, expectedGeneration)) {
        await this.kv().delete(streamId);
        await this.kv().deleteWithExtension(
          streamId,
          STREAM_LOG_JOURNAL_EXTENSION,
        );
        await this.deleteLegacySummaryEntry(streamId);
        return;
      }
      if (!this.hasPendingPersistence(streamId)) return;
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
    // once. `summaries` is cleared here too; the in-flight
    // `writeTombstones` guard is intentionally left untouched — its lifetime
    // is owned by `delete()`'s try/finally, not by this cascade.
    this.streams.delete(streamId);
    this.persistenceQueues.delete(streamId);
    this.releaseRequests.delete(streamId);
    this.summaries.delete(streamId);
    this.pendingSummaryMeta.delete(streamId);
  }

  private forgetAllStreamState(): void {
    // Same single-drop as `forgetStreamState`, store-wide. `writeTombstones`
    // is deliberately not cleared here — `clear()` owns and clears it in its
    // own finally block.
    this.streams.clear();
    this.persistenceQueues.clear();
    this.releaseRequests.clear();
    this.summaries.clear();
    this.pendingSummaryMeta.clear();
  }

  private assertWritableStore(operation: string): void {
    if (this.mode.kind !== 'read-only') return;
    throw new Error(`Cannot ${operation} with a read-only transcript store.`);
  }

  private async deleteLegacySummaryEntry(streamId: StreamTabId): Promise<void> {
    try {
      await this.legacySummaryKv().delete(streamId);
    } catch (error) {
      log.warn(
        `Failed to delete retired transcript summary for ${streamId}: ${toErrorMessage(error)}`,
      );
    }
  }

  private async cleanupLegacySummaryCache(): Promise<void> {
    try {
      await this.legacySummaryKv().deleteDir();
    } catch (error) {
      log.warn(
        `Failed to remove retired transcript summary directory: ${toErrorMessage(error)}`,
      );
    }
  }

  private markPersistentChange(streamId: StreamTabId): void {
    const state = this.ensureStreamState(streamId);
    state.summaryDirty = true;
    this.acquireLease(streamId, 'flush');
    this.schedulePersistence(streamId);
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
      this.hasPendingPersistence(streamId) ||
      state.persistenceWork !== undefined ||
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

  /**
   * Read the canonical journal. A legacy array is converted once into a seed
   * record and unlinked only after the atomic journal replacement succeeds.
   */
  private async readPersistedEntries(
    streamId: StreamTabId,
  ): Promise<ParsedPersistedEntries | undefined> {
    const work = this.runInPersistenceQueue(streamId, () =>
      this.readPersistedEntriesSerialized(streamId),
    );
    const completion = work.then(
      () => undefined,
      () => undefined,
    );
    this.ensureStreamState(streamId).pendingRead = completion;
    try {
      return await work;
    } finally {
      const state = this.streams.get(streamId);
      if (state?.pendingRead === completion) {
        state.pendingRead = undefined;
        this.pruneStreamState(streamId);
      }
    }
  }

  private async readPersistedEntriesSerialized(
    streamId: StreamTabId,
  ): Promise<ParsedPersistedEntries | undefined> {
    const journal = await this.kv().readText(
      streamId,
      STREAM_LOG_JOURNAL_EXTENSION,
    );
    if (journal === undefined) {
      const legacy = await this.kv().read<unknown>(streamId);
      if (legacy === undefined) return undefined;
      const base = this.parsePersistedEntries(streamId, legacy);
      if (this.mode.kind === 'persistent') {
        await this.replaceWithSeedJournal(streamId, legacy as unknown[]);
      }
      return base;
    }

    const parsedJournal = parseJsonlEntries(streamId, journal);
    const parsedRecords = parsedJournal.entries.map((raw) =>
      StreamLogJournalRecordSchema.safeParse(raw),
    );
    const journalHasSeed = parsedRecords.some(
      (result) => result.success && result.data.op === 'seed',
    );
    const legacyExists = await this.kv().exists(streamId);
    const legacy =
      legacyExists && !journalHasSeed
        ? await this.kv().read<unknown>(streamId)
        : undefined;
    const base =
      legacy === undefined
        ? { entries: [], preservedRawEntries: [] }
        : this.parsePersistedEntries(streamId, legacy);
    if (
      parsedJournal.repairedText !== undefined &&
      this.mode.kind === 'persistent'
    ) {
      await this.kv().writeTextAtomic(
        streamId,
        STREAM_LOG_JOURNAL_EXTENSION,
        parsedJournal.repairedText,
      );
    }

    let currentBase = base;
    let logInstance = new StreamLog(base.entries, base.preservedRawEntries);
    let summaryCheckpointSeen = false;
    let summaryMeta: StreamSummaryMeta | undefined;
    let sawSeed = false;
    const seen = new Map<string, StreamLogJournalRecord>();
    let invalidRecords = 0;
    const invalidJournalValues: unknown[] = [];
    for (const [index, result] of parsedRecords.entries()) {
      if (!result.success) {
        invalidRecords += 1;
        const raw = parsedJournal.entries[index];
        if (raw !== undefined) invalidJournalValues.push(raw);
        continue;
      }
      const record = result.data;
      const previous = seen.get(record.opId);
      if (previous !== undefined) {
        if (!isDeepStrictEqual(previous, record)) {
          throw new Error(
            `Stream ${streamId}: duplicate journal operation ${record.opId} differs from its first record.`,
          );
        }
        continue;
      }
      seen.set(record.opId, record);
      switch (record.op) {
        case 'seed': {
          if (sawSeed) {
            log.warn(
              `Stream ${streamId}: ignoring an additional journal seed record.`,
            );
            break;
          }
          currentBase = this.parsePersistedEntries(streamId, record.entries);
          logInstance = new StreamLog(
            currentBase.entries,
            currentBase.preservedRawEntries,
          );
          sawSeed = true;
          break;
        }
        case 'ensure':
          break;
        case 'checkpoint':
          summaryCheckpointSeen = true;
          summaryMeta = record.summary.meta;
          break;
        case 'append': {
          const {
            seqNo: _seqNo,
            settlementSeqNo: _settlementSeqNo,
            ...entry
          } = record.entry;
          if (record.settled) logInstance.appendSettled(entry);
          else logInstance.append(entry);
          break;
        }
        case 'update':
          {
            const current = logInstance.getById(record.id);
            const patch = current
              ? parsePersistedUpdate(current, record.patch)
              : (record.patch as StreamLogUpdatePatch);
            if (!patch) {
              invalidRecords += 1;
              const raw = parsedJournal.entries[index];
              if (raw !== undefined) invalidJournalValues.push(raw);
              break;
            }
            if (record.settled) {
              logInstance.settle(record.id, patch);
            } else {
              logInstance.update(record.id, patch);
            }
          }
          break;
      }
    }
    if (invalidRecords > 0) {
      log.warn(
        `Stream ${streamId}: ${formatResultCount(invalidRecords, 'journal record')} did not parse; preserving the raw values.`,
      );
    }

    const parsed = {
      entries: logInstance.toJSON(),
      preservedRawEntries: currentBase.preservedRawEntries,
      ...(summaryCheckpointSeen && { summaryCheckpointSeen }),
      ...(summaryMeta && { summaryMeta }),
    };
    if (this.mode.kind === 'persistent' && legacyExists) {
      if (!sawSeed) {
        // One-time conversion of the unshipped JSON-plus-JSONL overlay shape,
        // as well as ordinary legacy arrays, into one canonical journal.
        await this.replaceWithSeedJournal(streamId, [
          ...logInstance.toPersistedEntries(),
          ...invalidJournalValues,
        ]);
      } else {
        await this.deleteLegacyLog(streamId);
      }
    }
    return parsed;
  }

  private async replaceWithSeedJournal(
    streamId: StreamTabId,
    entries: readonly unknown[],
  ): Promise<void> {
    const seed = toJournalRecord({ op: 'seed', entries });
    await this.kv().writeTextAtomic(
      streamId,
      STREAM_LOG_JOURNAL_EXTENSION,
      `${JSON.stringify(seed)}\n`,
    );
    await this.deleteLegacyLog(streamId);
  }

  private async deleteLegacyLog(streamId: StreamTabId): Promise<void> {
    try {
      await this.kv().delete(streamId);
    } catch (error) {
      log.warn(
        `Failed to remove retired transcript array for ${streamId}: ${toErrorMessage(error)}`,
      );
    }
  }

  private async hasPersistedStream(streamId: StreamTabId): Promise<boolean> {
    const [legacy, journal] = await Promise.all([
      this.kv().exists(streamId),
      this.kv().existsWithExtension(streamId, STREAM_LOG_JOURNAL_EXTENSION),
    ]);
    return legacy || journal;
  }
}
