/**
 * Host-agnostic per-stream sidecar persistence.
 *
 * One store, shared by the CLI TUI, VS Code extension, and Electron desktop
 * app, that is the SINGLE writer of `streamData/{id}/*` and the reader that
 * reassembles a {@link StreamSnapshot} for resume. Session/run facts are fed
 * through {@link attachSessionEvents}, while host-owned callers use the public
 * mutators below. Both paths persist the same field-scoped files, including the
 * `workPlan.json` giving todos/plan a durable home.
 *
 * It owns the accumulation of output files, usage, and stream meta, talking to
 * `KVStore` directly via the shared `streamDataDir()` layout. Writes are
 * serialized per (stream, category) so concurrent deltas never interleave.
 *
 * Liveness (active children, RUNNING status) is deliberately NOT persisted —
 * `read()` returns durable display state only; hosts clamp liveness on hydrate.
 */

import { Mutex } from 'async-mutex';
import pMap from 'p-map';
import { z } from 'zod';

import { getExecutionStore } from '@agent/storage';
import type { AgentEvent } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { isFileNotFoundError } from '@common/errors';
import { KVStore } from '@common/storage/KVStore';
import { KVStoreCache } from '@common/storage/KVStoreCache';
import { createLog } from '@logger/logUtils';
import {
  CompileFailureSchema,
  cloneRoundIndexed,
  emptyUsageStats,
  isEmptyUsage,
  OutputFileInfoListSchema,
  PersistedWorkPlanSchema,
  STREAM_TAB_META_SCHEMA_VERSION,
  planSummaryLine,
  RoundKeySchema,
  sumUsageStats,
  TokenUsageStatsParsingBaseSchema,
  type CompileFailure,
  type ExecutionId,
  type OutputFileInfo,
  type RunIdentity,
  type Plan,
  type RoundIndexed,
  type StorageKey,
  type StreamSnapshot,
  type StreamTabId,
  type StreamTabMeta,
  type TodoItem,
  type TokenUsageStats,
  type UserFollowUpSupport,
  type WorkPlanSnapshot,
  formatZodIssuesMessage,
} from '@shared/schemas';

import { mapToRecord, throwAggregated } from '@utils/core';
import { StorageFS } from '@utils/files/storageFS';
import { isDirectory } from '@utils/files/fsEntryType';

import { ResidentStreamRegistry } from './ResidentStreamRegistry';
import {
  StagedDeletionCoordinator,
  type StagedDeletionHost,
  type StagedStreamSnapshotDeletion,
} from './StagedDeletionCoordinator';
import {
  decodeStreamId,
  STREAM_DATA_DELETION_DIR,
  STREAM_DATA_DIR,
  STREAM_DATA_KEYS,
  streamDataDir,
} from './streamDataPaths';
import {
  assembleSnapshot,
  EMPTY_WORK_PLAN,
  emptyStreamData,
  readMeta,
  readStreamData,
  type StreamData,
} from './streamSnapshotRead';
import type { StreamSummaryMeta } from './StreamLogStore';

const log = createLog('StreamSnapshotStore');

/** Bounded fan-out for seeding many streams' sidecars, so startup does not
 *  open a file handle per tab. */
const SEED_IO_CONCURRENCY = 8;
/** Bound retries for writes that remain dirty. */
const MAX_DIRTY_WRITE_RETRIES = 3;

class DirtySidecarWritesError extends Error {}

/**
 * The run facts this store subscribes to, and the single source of truth for
 * the `attachSessionEvents` run-fact switch.
 *
 * Kept as one frozen tuple (the `RUN_FACT_EVENT_TYPES` idiom in
 * `@agent/trace`) so the runtime subscription filter and the compile-time
 * handled union cannot drift: extend this list and the switch's `default` arm
 * stops type-checking until the new fact is handled.
 */
const SNAPSHOT_RUN_FACT_TYPES = Object.freeze([
  'run.start',
  'run.config',
  'usage',
  'updateTodos',
  'updatePlan',
  'addOutputFiles',
  'updateMissingOutputs',
  'updateCompileFailures',
] as const satisfies readonly AgentEvent['type'][]);

type SnapshotRunFactType = (typeof SNAPSHOT_RUN_FACT_TYPES)[number];

/** The `AgentEvent` arms named by {@link SNAPSHOT_RUN_FACT_TYPES}. */
type SnapshotRunFact = Extract<AgentEvent, { type: SnapshotRunFactType }>;

const SNAPSHOT_RUN_FACT_TYPE_SET: ReadonlySet<AgentEvent['type']> = new Set(
  SNAPSHOT_RUN_FACT_TYPES,
);

function isSnapshotRunFact(event: AgentEvent): event is SnapshotRunFact {
  return SNAPSHOT_RUN_FACT_TYPE_SET.has(event.type);
}

type OutputFilesPatch = Map<number, OutputFileInfo[] | null>;
type UsageUpdateResult =
  TokenUsageStats | undefined | Promise<TokenUsageStats | undefined>;
interface HydratedRunState {
  authorityReadComplete: boolean;
  config?: AgentConfig;
  identity?: RunIdentity;
  userFollowUpSupport?: UserFollowUpSupport;
  description?: string;
}

function withoutSummaryMetaFields(
  meta: StreamSummaryMeta | undefined,
  fields: readonly (keyof StreamSummaryMeta)[],
): StreamSummaryMeta | undefined {
  if (!meta) return undefined;
  const remaining = { ...meta };
  for (const field of fields) delete remaining[field];
  return Object.keys(remaining).length > 0 ? remaining : undefined;
}

/**
 * The five execution-scoped facts owned by one run record and replaced or
 * hydrated together when a stream changes execution.
 */
export interface RunMetadata {
  readonly executionId?: ExecutionId;
  readonly identity?: RunIdentity;
  readonly userFollowUpSupport?: UserFollowUpSupport;
  readonly config?: AgentConfig;
  readonly description?: string;
}

/**
 * Merge a round-keyed patch (per round: a value list, or `null` to delete
 * that round) into an existing overlay patch, later entries winning. Shared
 * by every round-keyed accumulator overlay (output files, missing outputs,
 * compile failures) — they're all the same shape, so one merge function
 * services all three via {@link StreamSnapshotStore.mutateWithOverlay}.
 */
function mergeRoundPatch<T>(
  existing: Map<number, T[] | null> | undefined,
  patch: Map<number, T[] | null>,
): Map<number, T[] | null> {
  const merged = existing ?? new Map<number, T[] | null>();
  for (const [round, value] of patch) merged.set(round, value);
  return merged;
}

/**
 * Overlay shape for {@link StreamSnapshotStore.updateMissingOutputs} /
 * {@link StreamSnapshotStore.clearMissingOutputs} on an unseeded stream:
 * `reset` records that a `clearMissingOutputs()` happened somewhere in the
 * recorded sequence, so replay wipes the disk-read state before layering
 * `patch` on top, instead of merging onto stale disk rounds a clear was
 * supposed to erase.
 */
interface RoundOverlay<T> {
  reset: boolean;
  patch: Map<number, T[] | null>;
}

/** Partial work-plan fields recorded while a stream is unseeded. */
interface WorkPlanOverlay {
  todos?: readonly TodoItem[];
  plan?: Plan | null;
}

/**
 * The overlay patch each accumulator records while its stream is unseeded,
 * keyed by accumulator. One map keyed by field name lets
 * {@link StreamSnapshotStore.mutateWithOverlay} take the field name instead of
 * a getter/setter pair per call site.
 */
interface OverlayPatches {
  outputFiles: OutputFilesPatch;
  missingOutputs: RoundOverlay<string>;
  compileFailures: Map<number, CompileFailure[] | null>;
  usage: Map<StorageKey, TokenUsageStats>;
  workPlan: WorkPlanOverlay;
}

/**
 * Overlay field → sidecar key. The single enumeration of which overlay patch
 * flushes to which sidecar: both `applyStreamData` and `persistEagerOverlays`
 * collect their write sets through this table, and the `satisfies` makes a
 * new {@link OverlayPatches} field a compile error here until its sidecar is
 * named.
 */
const OVERLAY_TO_SIDECAR_KEY = {
  outputFiles: STREAM_DATA_KEYS.OUTPUT_FILES,
  missingOutputs: STREAM_DATA_KEYS.MISSING_OUTPUTS,
  compileFailures: STREAM_DATA_KEYS.COMPILE_FAILURES,
  usage: STREAM_DATA_KEYS.USAGE_STATS,
  workPlan: STREAM_DATA_KEYS.WORK_PLAN,
} as const satisfies Record<keyof OverlayPatches, string>;

/** Sidecar keys an overlay flush can target (values of {@link OVERLAY_TO_SIDECAR_KEY}). */
type OverlaySidecarKey =
  (typeof OVERLAY_TO_SIDECAR_KEY)[keyof typeof OVERLAY_TO_SIDECAR_KEY];

/** Later unseeded todos/plan patches win per field. */
function mergeWorkPlanOverlay(
  existing: WorkPlanOverlay | undefined,
  patch: WorkPlanOverlay,
): WorkPlanOverlay {
  return { ...existing, ...patch };
}

/**
 * Merge {@link RoundOverlay} patches in call order so `clearMissingOutputs`
 * interleaved with `updateMissingOutputs` on the same unseeded stream
 * replays correctly regardless of which fired first: a reset (`clear`)
 * supersedes everything recorded before it — it drops the earlier round
 * patch outright, matching a disk write of `{}` — while a later update
 * layers its round patch on top and preserves whichever reset flag is
 * already recorded.
 */
function mergeMissingOutputsOverlay(
  existing: RoundOverlay<string> | undefined,
  patch: RoundOverlay<string>,
): RoundOverlay<string> {
  if (patch.reset) return patch;
  return {
    reset: existing?.reset ?? false,
    patch: mergeRoundPatch(existing?.patch, patch.patch),
  };
}

/**
 * Merge a per-run usage delta patch into an existing overlay patch,
 * accumulating (not replacing) each run's totals — mirrors the in-memory
 * sum `applyUsageDeltaMemory` performs, so the overlay replayed after
 * seeding matches what was already applied eagerly.
 */
function mergeUsagePatch(
  existing: Map<StorageKey, TokenUsageStats> | undefined,
  patch: Map<StorageKey, TokenUsageStats>,
): Map<StorageKey, TokenUsageStats> {
  const merged = existing ?? new Map<StorageKey, TokenUsageStats>();
  for (const [storageKey, delta] of patch) {
    merged.set(
      storageKey,
      sumUsageStats([merged.get(storageKey) ?? emptyUsageStats(), delta]),
    );
  }
  return merged;
}

/**
 * Disk provenance for one stream record, a strictly per-record fact.
 * 'unknown': this record's on-disk sidecar state has not been established, so
 * a mutation must queue behind the per-stream seed chain (an accumulate/merge
 * onto an unloaded base would persist empty+delta over the real sidecar).
 * 'loaded': a seed/refresh read the sidecar files into memory.
 * 'verified-absent': an existence probe found no sidecar directory, so the
 * stream is new, memory is its full history, and mutations may persist
 * without a disk read. Never inferred from any global fact (#9956).
 */
type DiskState = 'unknown' | 'verified-absent' | 'loaded';

/**
 * Every per-stream field this store tracks, keyed by stream id in ONE map
 * (`records`): the accumulators, the `diskState`/`seedChain` seeding
 * bookkeeping, and the overlay patches. Because every field
 * for a stream lives on the same object, dropping a stream's memory is one
 * `records.delete(stream)` — every field disappears with it BY CONSTRUCTION,
 * so `evict()`/`evictAll()` cannot drift from the field list.
 *
 * Per-stream version counters (must survive eviction to keep guarding
 * in-flight seed races) live inside the shared {@link ResidentStreamRegistry}
 * container that backs `records`, not on the record itself. `writeMutexes`
 * (keyed by the compound `${stream}::${key}`, not a bare stream id) stays as
 * its own map on the store — the same exclusion #7892 already carved out of
 * `perStreamStores()`.
 */
interface StreamRecord {
  // -- Accumulated durable state (mirrors on-disk StreamData) --------------
  outputFiles: RoundIndexed<OutputFileInfo>;
  missingOutputs: RoundIndexed<string>;
  compileFailures: RoundIndexed<CompileFailure>;
  usage: Map<string, TokenUsageStats>;
  /**
   * Per-run usage values read from disk that failed to parse, preserved
   * verbatim so `writeUsage` can round-trip them back unchanged instead of a
   * lossy read permanently deleting them on the next save (#7464).
   */
  usageUnparsed: Map<string, unknown>;
  workPlan: WorkPlanSnapshot;
  meta: StreamTabMeta | undefined;
  /**
   * Run identity: the execution id, identity, and config of the ONE execution
   * `meta` names, always for the same execution (a `run.start` for a new one
   * drops the previous run's config with it). The identity is immutable per
   * execution, so the live `run.start` owns it and a seed only fills an
   * absence from the durable `ExecutionMeta`. The config is mutable and
   * persisted — a model switch rewrites `executions/{id}/config.json` and
   * re-emits `run.config` — so `config.json` owns it and a seed re-reads it,
   * yielding only to a live event that landed after the seed read disk.
   */
  runExecutionId: ExecutionId | undefined;
  runIdentity: RunIdentity | undefined;
  userFollowUpSupport: UserFollowUpSupport | undefined;
  runConfig: AgentConfig | undefined;
  /**
   * Display description projected from the authority,
   * `ExecutionMeta.description` (#9590 A4): set by the live
   * `updateStreamDescription` session event (whose emitters persist to
   * ExecutionMeta first) or by load-time hydration from ExecutionMeta.
   * In-memory only — never written to the stream sidecar, which no longer
   * carries a description field at all (the legacy mirror was deliberately
   * retired early with the run-classification consolidation).
   */
  description: string | undefined;
  /** Same-execution mirror fields retained across a transient authority read. */
  summaryMetaHydrationFallback: StreamSummaryMeta | undefined;

  // -- Lazy seeding: a stream's existing disk data is read into memory BEFORE
  // the first mutation so an accumulate/merge can't overwrite unloaded disk
  // data. `diskState` = this record's disk provenance; `seedChain` serializes
  // refresh/seed/mutate for it.
  diskState: DiskState;
  seedChain: Promise<void> | undefined;
  /** Incremented for each refresh attempt; seed-gated mutations do not change it. */
  seedRefreshGeneration: number;
  /** Authoritative disk provenance captured before the current refresh chain began. */
  seedRefreshBaseline: DiskState | undefined;

  // -- Overlays: patches applied eagerly to memory while a seed is in flight,
  // so `applyStreamData`'s post-seed reconciliation can replay them on top of
  // the freshly-read disk state — an eager write racing ahead of its own seed
  // is never clobbered by that seed's raw disk read. See `mutateWithOverlay`.
  metaOverlay: boolean;
  overlays: Partial<OverlayPatches>;
}

interface DirtySidecarWrite {
  stream: StreamTabId;
  key: string;
  value: unknown;
}

export class StreamSnapshotStore {
  private readonly records = new ResidentStreamRegistry<
    StreamTabId,
    StreamRecord
  >(() => ({
    outputFiles: {},
    missingOutputs: {},
    compileFailures: {},
    usage: new Map(),
    usageUnparsed: new Map(),
    workPlan: EMPTY_WORK_PLAN,
    meta: undefined,
    runExecutionId: undefined,
    runIdentity: undefined,
    userFollowUpSupport: undefined,
    runConfig: undefined,
    description: undefined,
    summaryMetaHydrationFallback: undefined,
    diskState: 'unknown',
    seedChain: undefined,
    seedRefreshGeneration: 0,
    seedRefreshBaseline: undefined,
    metaOverlay: false,
    overlays: {},
  }));
  /**
   * Lazily-created per-stream handles over `streamDataDir(streamId)`. A
   * handle is a stateless wrapper, so dropping one is lossless:
   * `evict()`/`evictAll()` drop handles alongside the records, and
   * {@link invalidateKvHandles} forces re-resolution after a stream's
   * directory may have moved (staged-deletion rollback, storage-root
   * refresh).
   */
  private readonly kvHandles = new KVStoreCache<StreamTabId>(
    (streamId) => new KVStore(streamDataDir(streamId)),
  );
  /**
   * The crash-safe staged-deletion + rollback-recovery machine. It owns which
   * namespace holds a staged stream's data and the sidecar writes buffered
   * behind that rename; this store keeps the records, KV handles, write
   * mutexes, and stream versions it reaches back for through
   * {@link StagedDeletionHost}.
   */
  private readonly deletions = new StagedDeletionCoordinator({
    queueWrite: (stream, key, value) => this.queueWrite(stream, key, value),
    cancelPendingWrites: (stream) => this.cancelPendingWritesForStream(stream),
    bumpStreamVersion: (stream) => this.records.bumpVersion(stream),
    seedChain: (stream) => this.records.get(stream)?.seedChain,
    invalidateKvHandles: (stream) => this.invalidateKvHandles(stream),
    evict: (stream) => this.evict(stream),
  } satisfies StagedDeletionHost);

  // -- Per (stream, category) serialized write locks -------------------------
  private readonly writeMutexes = new Map<string, Mutex>();
  /** Latest ordinary sidecar value not yet confirmed durable, by write lock. */
  private readonly dirtyWrites = new Map<string, DirtySidecarWrite>();

  /** Streams already warned about a pre-identity execution row (#9590 Stage
   *  7), so repeated hydrations of the same old row stay one warning each. */
  private readonly preIdentityWarned = new Set<StreamTabId>();

  /**
   * `${stream}::${accessor}` pairs already warned about a synchronous read
   * served from a record with unestablished disk provenance, so a render
   * loop re-reading the same stream stays one warning per accessor instead
   * of log spam. Cleared per stream on evict (a re-seeded stream that is
   * read too early again deserves a fresh warning).
   */
  private readonly unseededReadWarned = new Set<string>();

  /**
   * Mirror of this store's display metadata into the always-resident stream
   * summaries, so sidebars and all-streams metadata paths never read
   * sidecars (#9947). Publishing is best-effort presentation fan-out;
   * this store stays the authority.
   */
  private summaryMetaSink:
    ((stream: StreamTabId, meta: StreamSummaryMeta) => void) | undefined;
  private summaryMetaSource:
    ((stream: StreamTabId) => StreamSummaryMeta | undefined) | undefined;

  /**
   * Publish the whole current metadata view of a stream to the summary
   * mirror. Called after every metadata mutation and after sidecar
   * hydration, which is also what lazily backfills summaries written before
   * the mirror existed. `command` is bounded by construction: only a
   * process run's command line ever rides it — an agent run's full
   * instruction text never leaves the sidecar/config authority.
   */
  private publishSummaryMeta(stream: StreamTabId): void {
    const sink = this.summaryMetaSink;
    if (!sink) return;
    const record = this.records.get(stream);
    if (!record) return;
    const config = record.runConfig;
    sink(stream, {
      ...record.summaryMetaHydrationFallback,
      ...(record.runIdentity !== undefined && { identity: record.runIdentity }),
      ...(record.runExecutionId !== undefined && {
        executionId: record.runExecutionId,
      }),
      ...(record.meta?.parentStreamId !== undefined && {
        parentStreamId: record.meta.parentStreamId,
      }),
      ...(record.userFollowUpSupport !== undefined && {
        userFollowUpSupport: record.userFollowUpSupport,
      }),
      ...(record.description !== undefined && {
        description: record.description,
      }),
      ...(config && {
        agentCategory: config.agentCategory,
        ...(config.model !== undefined && { model: config.model }),
        ...(config.workingDirectory != null && {
          workingDirectory: config.workingDirectory,
        }),
        ...(record.runIdentity?.kind === 'process' &&
          config.instruction !== undefined && { command: config.instruction }),
      }),
    });
  }

  /**
   * Loud unhydrated access (#9947): a synchronous accessor about to serve a
   * record whose disk provenance is unestablished ('unknown' or absent) says
   * so once per (stream, accessor) instead of silently returning a default
   * that may be missing this stream's persisted sidecar state.
   */
  private warnIfUnseeded(accessor: string, stream: StreamTabId): void {
    if (this.hasDiskProvenance(stream)) return;
    const key = `${stream}::${accessor}`;
    if (this.unseededReadWarned.has(key)) return;
    this.unseededReadWarned.add(key);
    log.warn(
      `${accessor}(${stream}) served a record with unestablished disk ` +
        `provenance; persisted sidecar state may be missing from the ` +
        `result. Await preload([stream]) first or read the stream summary ` +
        `instead (#9947).`,
    );
  }

  private getOrCreateRecord(stream: StreamTabId): StreamRecord {
    return this.records.getOrCreate(stream);
  }

  private kv(streamId: StreamTabId): KVStore {
    // Record creation on read-only access stays deliberate (see
    // clearMissingOutputs): hasDiskProvenance() keys off record presence.
    this.getOrCreateRecord(streamId);
    return this.kvHandles.get(streamId);
  }

  /** Drop the cached KV handle so the next access re-resolves against the stream's current directory. */
  private invalidateKvHandles(stream: StreamTabId): void {
    this.kvHandles.invalidate(stream);
  }

  private async listStreamsUnder(root: string): Promise<StreamTabId[]> {
    try {
      const entries = await StorageFS.readDir(root);
      return entries
        .filter(([, type]) => isDirectory(type))
        .map(([encoded]) => decodeStreamId(encoded))
        .filter((stream): stream is StreamTabId => stream !== undefined);
    } catch (error) {
      if (isFileNotFoundError(error)) return [];
      throw error;
    }
  }

  private streamVersion(stream: StreamTabId): number {
    return this.records.version(stream);
  }

  /**
   * Whether this record's disk provenance is established ('loaded' or
   * 'verified-absent'), so a mutation may apply and persist without first
   * consulting disk. Strictly per record: a record starts 'unknown' and only
   * its own seed chain resolves that; no global fact ever stands in for
   * "this record's disk state is in memory" (#9956).
   */
  private hasDiskProvenance(stream: StreamTabId): boolean {
    const state = this.records.get(stream)?.diskState;
    return state !== undefined && state !== 'unknown';
  }

  /**
   * Persist already-migrated durable facts directly from the session event
   * plane. `summaryMetaSink` rides the same attachment (the surface stays
   * one member): it wires the summary registry that mirrors this store's
   * display metadata, invoked on every metadata mutation and hydration.
   */
  attachSessionEvents(
    events: SessionEventHub,
    options?: {
      summaryMetaSink?: (stream: StreamTabId, meta: StreamSummaryMeta) => void;
      summaryMetaSource?: (
        stream: StreamTabId,
      ) => StreamSummaryMeta | undefined;
    },
  ): () => void {
    if (options?.summaryMetaSink) {
      this.summaryMetaSink = options.summaryMetaSink;
    }
    if (options?.summaryMetaSource) {
      this.summaryMetaSource = options.summaryMetaSource;
    }
    const detachRunEvents = events.subscribe(
      (sessionEvent) => {
        if (sessionEvent.scope !== 'run') return;
        const { event } = sessionEvent;
        // The hub filters by `SNAPSHOT_RUN_FACT_TYPES` at runtime but still
        // types the callback as the whole `SessionEvent`, so narrow to the
        // subscribed set here. That is what lets the `default` arm below be a
        // real exhaustiveness check instead of a silent catch-all.
        if (!isSnapshotRunFact(event)) return;

        switch (event.type) {
          case 'run.start':
            this.setRunStart(
              event.streamId,
              event.executionId,
              event.identity,
              event.userFollowUpSupport,
            );
            return;
          case 'run.config':
            this.setRunConfig(event.streamId, event.config, event.executionId);
            return;
          case 'usage':
            // `addUsage`'s safeParse is the wire→domain narrowing boundary.
            void this.addUsage(
              event.payload.streamId,
              event.payload.storageKey,
              event.payload.usage,
            );
            return;
          case 'updateTodos':
            this.setTodos(event.streamId, event.todos);
            return;
          case 'updatePlan':
            this.setPlan(event.streamId, event.plan);
            return;
          case 'addOutputFiles':
            this.addOutputFiles(event.streamId, event.filesByRound);
            return;
          case 'updateMissingOutputs':
            this.updateMissingOutputs(event.streamId, event.filesByRound);
            return;
          case 'updateCompileFailures':
            this.updateCompileFailures(event.streamId, event.filesByRound);
            return;
          default: {
            // Exhaustiveness check: adding a type to `SNAPSHOT_RUN_FACT_TYPES`
            // without handling it here is a compile error, not a silent drop.
            const unhandled: never = event;
            return unhandled;
          }
        }
      },
      { scope: 'run', types: SNAPSHOT_RUN_FACT_TYPES },
    );
    const detachSessionEvents = events.subscribe(
      (sessionEvent) => {
        if (sessionEvent.scope !== 'session') return;
        switch (sessionEvent.event.type) {
          case 'clearMissingOutputs':
            // Exactly addressed (#9590 rule A3): the payload carries the
            // initiator-selected streamId; there is no config fan-out.
            this.clearMissingOutputs(sessionEvent.event.payload.streamId);
            return;
          case 'updateStreamDescription':
            this.setDescription(
              sessionEvent.event.payload.streamId,
              sessionEvent.event.payload.description,
            );
            return;
          case 'setParentStream':
            this.setParentStream(
              sessionEvent.event.payload.childStreamId,
              sessionEvent.event.payload.parentStreamId,
            );
            return;
          default:
            return;
        }
      },
      { scope: 'session' },
    );

    return () => {
      detachSessionEvents();
      detachRunEvents();
    };
  }

  /**
   * Run a mutation only once the stream's disk provenance is established;
   * otherwise queue it behind the per-stream seed chain so it merges onto the
   * real sidecar state instead of an empty base. Eager memory application in
   * the overlay mutators keeps read-back immediate either way.
   */
  private mutate<T>(stream: StreamTabId, apply: () => T): T | undefined {
    const version = this.streamVersion(stream);
    if (this.hasDiskProvenance(stream)) return apply();

    this.queueAfterSeed(stream, version, apply);
    return undefined;
  }

  private queueAfterSeed(
    stream: StreamTabId,
    version: number,
    apply: () => unknown,
  ): Promise<void> {
    const next: Promise<void> = this.ensureSeeded(stream, version)
      .catch((err: unknown) => {
        if (!this.hasDiskProvenance(stream)) throw err;
      })
      .then(() => {
        if (this.streamVersion(stream) !== version) return;
        const record = this.records.get(stream);
        if (!record || record.diskState === 'unknown') {
          if (record?.seedChain === next) record.seedChain = undefined;
          return;
        }
        apply();
      })
      .catch((err: unknown) => {
        const record = this.records.get(stream);
        if (record?.diskState === 'unknown' && record.seedChain === next) {
          record.seedChain = undefined;
        }
        log.warn(`Deferred update failed for stream ${stream}`, {
          data: err,
        });
      });
    this.getOrCreateRecord(stream).seedChain = next;
    return next;
  }

  /** Read a stream's existing disk data into memory once. */
  private ensureSeeded(stream: StreamTabId, version: number): Promise<void> {
    const existing = this.records.get(stream)?.seedChain;
    if (existing) return existing;
    const seed = this.readSeed(stream, version);
    this.getOrCreateRecord(stream).seedChain = seed;
    return seed;
  }

  private async readSeed(stream: StreamTabId, version: number): Promise<void> {
    if (this.streamVersion(stream) !== version) return;
    if (this.hasDiskProvenance(stream)) return;
    await this.retryDirtyWrites(stream);
    if (this.streamVersion(stream) !== version) return;
    await this.seedFromDisk(stream, version);
  }

  /**
   * Establish a stream's disk provenance: one existence probe of the sidecar
   * directory (a single `listKeys` through the same KVStore handle every
   * other sidecar access uses), then the full read only when sidecar files
   * exist. A freshly minted stream resolves to 'verified-absent' from the
   * probe alone, so its first mutation costs one directory listing instead
   * of a six-file read and every later mutation applies synchronously.
   */
  private async seedFromDisk(
    stream: StreamTabId,
    version: number,
  ): Promise<void> {
    let exists: boolean;
    try {
      exists = (await this.kv(stream).listKeys()).length > 0;
    } catch (error) {
      // The probe only ever shortcuts the read; a failed listing must not
      // fail the seed and must NEVER claim absence. Fall back to the full
      // read, whose own fallback policy governs unreadable storage.
      log.warn(
        `Sidecar existence probe failed for stream ${stream}; falling back to a full read.`,
        { data: error },
      );
      exists = true;
    }
    if (this.streamVersion(stream) !== version) return;
    const data = exists
      ? await readStreamData(this.kv(stream))
      : emptyStreamData();
    if (this.streamVersion(stream) !== version) return;
    await this.applyStreamData(
      stream,
      data,
      exists ? 'loaded' : 'verified-absent',
    );
  }

  // ==========================================================================
  // Mutators — event projection targets (#9590 Stage 5)
  //
  // Every mutator below is private: durable display facts enter this store
  // only through `attachSessionEvents`, so the session event plane is the
  // single mutation authority. Tests exercise them by emitting the
  // corresponding session/run facts on an attached `SessionEventHub`.
  // ==========================================================================

  /**
   * Shared round→value patch parsing for the round-keyed accumulators
   * (output files, missing outputs, compile failures). `normalize` returns
   * `null` to delete a round's entry (e.g. once its failure list empties
   * out) or the value list to store otherwise.
   */
  private parseRoundPatch<T>(
    filesByRound: Record<string, unknown>,
    normalize: (raw: unknown) => T[] | null,
  ): Map<number, T[] | null> {
    const patch = new Map<number, T[] | null>();
    for (const [round, raw] of Object.entries(filesByRound)) {
      const key = RoundKeySchema.safeParse(round);
      if (!key.success) continue;
      patch.set(key.data, normalize(raw));
    }
    return patch;
  }

  /**
   * Apply a parsed round-keyed patch to one round-keyed field of a stream's
   * record. `field` selects which field (output files / missing outputs /
   * compile failures) — always present on the record (defaulted at
   * creation), so no separate lazy-init step is needed here. Takes the
   * record, not the stream id, so `applyStreamData`'s post-hydration replay
   * can't re-resolve (and thereby resurrect) a record for a stream that was
   * evicted mid-hydration (#8226).
   */
  private applyRoundPatch<T>(
    field: (record: StreamRecord) => RoundIndexed<T>,
    record: StreamRecord,
    patch: Map<number, T[] | null>,
  ): RoundIndexed<T> {
    const rounds = field(record);
    for (const [round, value] of patch) {
      if (value === null) delete rounds[round];
      else rounds[round] = value;
    }
    return rounds;
  }

  private writeOutputFiles(stream: StreamTabId): void {
    // Shallow copy: the write is queued, so snapshot the record at call time
    // rather than letting later round mutations leak into a pending write.
    this.write(stream, STREAM_DATA_KEYS.OUTPUT_FILES, {
      ...this.records.get(stream)?.outputFiles,
    });
  }

  private applyUsageDeltaMemory(
    record: StreamRecord,
    storageKey: StorageKey,
    delta: TokenUsageStats,
  ): TokenUsageStats | undefined {
    if (isEmptyUsage(delta)) return record.usage.get(storageKey);
    const existing = record.usage.get(storageKey) ?? emptyUsageStats();
    const accumulated = sumUsageStats([existing, delta]);
    record.usage.set(storageKey, accumulated);
    return accumulated;
  }

  private writeUsage(stream: StreamTabId): void {
    const record = this.records.get(stream);
    const parsed = mapToRecord(record?.usage ?? new Map());
    const unparsed = record?.usageUnparsed;
    // Reinsert raw entries this store couldn't interpret so the write never
    // deletes them; a run that has since parsed successfully (`parsed`) wins
    // over its own stale raw fallback via spread order (#7464).
    const payload =
      unparsed && unparsed.size > 0
        ? { ...Object.fromEntries(unparsed), ...parsed }
        : parsed;
    this.write(stream, STREAM_DATA_KEYS.USAGE_STATS, payload);
  }

  /**
   * Shared eager-apply + overlay-reconcile shape for every accumulator that
   * patches per-stream state from a live progress event. `applyToMemory`
   * always runs immediately, so a caller can read its own write back
   * synchronously whether or not the stream is seeded yet. A seeded stream
   * also persists immediately (`persist`). An unseeded stream instead
   * records `overlayPatch` under `overlayKey` on the stream's record (merged
   * with anything still pending from an earlier unseeded mutation via
   * `mergePatch`), leaving `overlayPatch` `undefined` to skip recording
   * (used for effectively-empty patches). `applyStreamData`'s post-seed
   * reconciliation then replays the overlay on top of the freshly-read disk
   * state and persists it there, so an eager write racing ahead of its own
   * seed is never clobbered by that seed's raw disk read. Every round/usage
   * mutator goes through here, so a new one inherits that guarantee instead
   * of needing its own overlay block.
   */
  private mutateWithOverlay<T, K extends keyof OverlayPatches>(
    stream: StreamTabId,
    overlayKey: K,
    overlayPatch: OverlayPatches[K] | undefined,
    mergePatch: (
      existing: OverlayPatches[K] | undefined,
      patch: OverlayPatches[K],
    ) => OverlayPatches[K],
    applyToMemory: () => T,
    persist: () => void,
  ): { result: T; pending: Promise<void> | undefined } {
    const result = applyToMemory();

    if (this.hasDiskProvenance(stream)) {
      persist();
      return { result, pending: undefined };
    }

    const version = this.streamVersion(stream);
    if (overlayPatch !== undefined) {
      const { overlays } = this.getOrCreateRecord(stream);
      overlays[overlayKey] = mergePatch(overlays[overlayKey], overlayPatch);
    }
    return {
      result,
      pending: this.queueAfterSeed(stream, version, () => undefined),
    };
  }

  private addOutputFiles(
    stream: StreamTabId,
    filesByRound: RoundIndexed<OutputFileInfo>,
  ): void {
    const patch = this.parseRoundPatch<OutputFileInfo>(filesByRound, (raw) => {
      const normalized = OutputFileInfoListSchema.parse(
        Array.isArray(raw) ? raw : [],
      );
      return normalized.length === 0 ? null : normalized;
    });
    if (patch.size === 0) return;

    this.mutateWithOverlay(
      stream,
      'outputFiles',
      patch,
      mergeRoundPatch,
      () =>
        this.applyRoundPatch(
          (record) => record.outputFiles,
          this.getOrCreateRecord(stream),
          patch,
        ),
      () => this.writeOutputFiles(stream),
    );
  }

  private updateMissingOutputs(
    stream: StreamTabId,
    filesByRound: RoundIndexed<string>,
  ): void {
    const patch = this.parseRoundPatch<string>(filesByRound, (raw) =>
      z.array(z.string()).parse(Array.isArray(raw) ? raw : []),
    );
    if (patch.size === 0) return;

    this.mutateWithOverlay(
      stream,
      'missingOutputs',
      { reset: false, patch },
      mergeMissingOutputsOverlay,
      () =>
        this.applyRoundPatch(
          (record) => record.missingOutputs,
          this.getOrCreateRecord(stream),
          patch,
        ),
      () =>
        this.write(stream, STREAM_DATA_KEYS.MISSING_OUTPUTS, {
          ...this.records.get(stream)?.missingOutputs,
        }),
    );
  }

  private updateCompileFailures(
    stream: StreamTabId,
    filesByRound: RoundIndexed<CompileFailure>,
  ): void {
    const patch = this.parseRoundPatch<CompileFailure>(filesByRound, (raw) => {
      const normalized = CompileFailureSchema.array().parse(
        Array.isArray(raw) ? raw : [],
      );
      return normalized.length === 0 ? null : normalized;
    });
    if (patch.size === 0) return;

    this.mutateWithOverlay(
      stream,
      'compileFailures',
      patch,
      mergeRoundPatch,
      () =>
        this.applyRoundPatch(
          (record) => record.compileFailures,
          this.getOrCreateRecord(stream),
          patch,
        ),
      () =>
        this.write(stream, STREAM_DATA_KEYS.COMPILE_FAILURES, {
          ...this.records.get(stream)?.compileFailures,
        }),
    );
  }

  /**
   * Accumulate usage per run. Returns the accumulated value for the run so
   * callers can forward it to the UI.
   */
  private addUsage(
    stream: StreamTabId,
    storageKey: StorageKey,
    usage: TokenUsageStats,
  ): UsageUpdateResult {
    const parsed = TokenUsageStatsParsingBaseSchema.safeParse(usage);
    if (!parsed.success) {
      log.warn(
        `Discarding malformed usage delta for run ${storageKey} on stream ` +
          `${stream} instead of silently zeroing accumulated cost.`,
        {
          data: formatZodIssuesMessage(parsed.error.issues),
        },
      );
    }
    const delta = parsed.success ? parsed.data : emptyUsageStats();
    const version = this.streamVersion(stream);
    const overlayPatch = isEmptyUsage(delta)
      ? undefined
      : new Map<StorageKey, TokenUsageStats>([[storageKey, delta]]);

    const { result: accumulated, pending } = this.mutateWithOverlay(
      stream,
      'usage',
      overlayPatch,
      mergeUsagePatch,
      () =>
        this.applyUsageDeltaMemory(
          this.getOrCreateRecord(stream),
          storageKey,
          delta,
        ),
      () => {
        if (!isEmptyUsage(delta)) this.writeUsage(stream);
      },
    );

    if (!pending) return accumulated;
    return pending.then(() => {
      if (
        this.streamVersion(stream) !== version ||
        !this.hasDiskProvenance(stream)
      ) {
        return undefined;
      }
      return this.records.get(stream)?.usage.get(storageKey);
    });
  }

  // ==========================================================================
  // Read accessors over in-memory accumulated state
  // ==========================================================================

  // Deep-enough copies (fresh record, fresh per-round array): a caller that
  // mutates the returned value — including pushing into a returned round's
  // array — can never corrupt these in-memory accumulators. A shallow
  // `{ ...map }` spread would share the per-round arrays by reference.
  getOutputFiles(stream: StreamTabId): RoundIndexed<OutputFileInfo> {
    this.warnIfUnseeded('getOutputFiles', stream);
    return cloneRoundIndexed(this.records.get(stream)?.outputFiles);
  }

  getMissingOutputs(stream: StreamTabId): RoundIndexed<string> {
    this.warnIfUnseeded('getMissingOutputs', stream);
    return cloneRoundIndexed(this.records.get(stream)?.missingOutputs);
  }

  getCompileFailures(stream: StreamTabId): RoundIndexed<CompileFailure> {
    this.warnIfUnseeded('getCompileFailures', stream);
    return cloneRoundIndexed(this.records.get(stream)?.compileFailures);
  }

  getRunUsage(stream: StreamTabId): Map<string, TokenUsageStats> {
    this.warnIfUnseeded('getRunUsage', stream);
    return new Map(this.records.get(stream)?.usage ?? []);
  }

  /** Flattened set of known output-file paths for a stream. */
  getKnownFilePaths(
    stream: StreamTabId,
    options: { workspaceOnly?: boolean } = {},
  ): Set<string> {
    this.warnIfUnseeded('getKnownFilePaths', stream);
    const paths = new Set<string>();
    const rounds = this.records.get(stream)?.outputFiles;
    if (!rounds) return paths;
    const workspaceOnly = options.workspaceOnly ?? false;
    for (const infos of Object.values(rounds)) {
      for (const info of infos) {
        if (!workspaceOnly || info.location.kind === 'workspace') {
          paths.add(info.location.absolutePath);
        }
      }
    }
    return paths;
  }

  /**
   * Clear the missing-outputs marker for a stream (memory + disk). Goes
   * through the same `mutateWithOverlay` shape as `updateMissingOutputs` (via
   * the shared `reset`-aware overlay), so a clear and an update racing on the
   * same unseeded stream replay in call order instead of the clear always
   * landing last.
   *
   * `existed` checks `missingOutputs` content specifically, not merely
   * whether the stream has a record: every record defaults `missingOutputs`
   * to `{}` on creation, and a record gets created for read-only reasons
   * too (`kv()` — used by `read()`, `readPersistedExecutionId()`, and the
   * read-only `kv()` calls — as well as any other accumulator's own lazy
   * creation, e.g. `setTodos`). Gating on record
   * presence alone would treat those as "missing outputs existed" and write
   * a spurious `missingOutputs.json`, resurrecting a `streamData/{id}/`
   * directory `listPersistedStreams()` would then report for a stream that
   * was never actually tracking missing outputs (or was just deleted).
   */
  private clearMissingOutputs(stream: StreamTabId): void {
    let existed = false;
    this.mutateWithOverlay(
      stream,
      'missingOutputs',
      { reset: true, patch: new Map<number, string[] | null>() },
      mergeMissingOutputsOverlay,
      () => {
        const record = this.records.get(stream);
        existed = !!record && Object.keys(record.missingOutputs).length > 0;
        this.getOrCreateRecord(stream).missingOutputs = {};
      },
      () => {
        if (existed) this.write(stream, STREAM_DATA_KEYS.MISSING_OUTPUTS, {});
      },
    );
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /** Drop a stream's in-memory state. Disk cleanup is the caller's job. */
  private evict(stream: StreamTabId): void {
    this.records.evict(stream);
    this.kvHandles.invalidate(stream);
    for (const key of [...this.writeMutexes.keys()]) {
      if (!key.startsWith(`${stream}::`)) continue;
      this.writeMutexes.delete(key);
      this.dirtyWrites.delete(key);
    }
    for (const key of [...this.unseededReadWarned]) {
      if (key.startsWith(`${stream}::`)) this.unseededReadWarned.delete(key);
    }
  }

  evictAll(): void {
    this.records.evictAll();
    this.kvHandles.invalidateAll();
    this.writeMutexes.clear();
    this.dirtyWrites.clear();
    this.unseededReadWarned.clear();
    this.deletions.reset();
  }

  /**
   * Reconcile crash-interrupted deletions against the transcript registry.
   * A live transcript rolls its snapshot directory back. An absent transcript
   * restores the directory only into the orphan-cleanup namespace so the
   * execution directory and goal can be removed with the snapshot.
   */
  async reconcileStagedDeletions(
    liveStreams: ReadonlySet<StreamTabId>,
  ): Promise<{
    restored: StreamTabId[];
    pendingCleanup: StreamTabId[];
    discarded: StreamTabId[];
  }> {
    return this.deletions.reconcile(liveStreams);
  }

  /**
   * Atomically move a stream's sidecars out of the live namespace while
   * keeping its in-memory record available until the transcript registry
   * decides whether deletion commits.
   */
  async stageDeleteStream(
    stream: StreamTabId,
    onCommitted?: (children: readonly StreamTabId[]) => void | Promise<void>,
  ): Promise<StagedStreamSnapshotDeletion> {
    const deletion = await this.deletions.stage(stream);
    return {
      commit: async () => {
        await deletion.commit();
        let children: StreamTabId[] = [];
        try {
          children = await this.detachPersistedChildren(stream);
        } catch (error) {
          log.warn(
            `Stream ${stream} was deleted, but child parent-edge cleanup was incomplete.`,
            { data: error },
          );
        }
        try {
          await onCommitted?.(children);
        } catch (error) {
          log.warn(
            `Stream ${stream} was deleted, but child-detachment projection was incomplete.`,
            { data: error },
          );
        }
        try {
          await this.flush();
        } catch (error) {
          log.warn(
            `Stream ${stream} was deleted, but child parent-edge persistence was incomplete.`,
            { data: error },
          );
        }
      },
      rollback: () => deletion.rollback(),
    };
  }

  /** Delete a stream's sidecars and in-memory state as one committed action. */
  async deleteStream(stream: StreamTabId): Promise<void> {
    const deletion = await this.stageDeleteStream(stream);
    await deletion.commit();
  }

  /** Delete the entire `streamData/` tree + all in-memory state. */
  async deleteAll(): Promise<void> {
    const pending = [...this.writeMutexes.values()].map((mutex) =>
      mutex.waitForUnlock(),
    );
    this.evictAll();
    await Promise.all(pending);
    await Promise.all([
      new KVStore(STREAM_DATA_DIR).deleteDir(),
      StorageFS.delete(STREAM_DATA_DELETION_DIR, { recursive: true }).catch(
        (error: unknown) => {
          if (!isFileNotFoundError(error)) throw error;
        },
      ),
    ]);
  }

  private setTodos(stream: StreamTabId, todos: TodoItem[]): void {
    // Same eager-apply + overlay shape as the round/usage mutators: a live
    // updateTodos must be readable via getWorkPlan before the stream seeds,
    // and must survive applyStreamData's disk baseline.
    this.mutateWithOverlay(
      stream,
      'workPlan',
      { todos },
      mergeWorkPlanOverlay,
      () => {
        const record = this.getOrCreateRecord(stream);
        record.workPlan = { ...record.workPlan, todos };
      },
      () => {
        const record = this.records.get(stream);
        if (record) this.writeWorkPlan(stream, record.workPlan);
      },
    );
  }

  private setPlan(stream: StreamTabId, plan: Plan | null): void {
    this.mutateWithOverlay(
      stream,
      'workPlan',
      { plan },
      mergeWorkPlanOverlay,
      () => {
        const record = this.getOrCreateRecord(stream);
        record.workPlan = {
          ...record.workPlan,
          plan,
          planSummary: plan ? planSummaryLine(plan.objective) : null,
        };
      },
      () => {
        const record = this.records.get(stream);
        if (record) this.writeWorkPlan(stream, record.workPlan);
      },
    );
  }

  getWorkPlan(stream: StreamTabId): WorkPlanSnapshot {
    this.warnIfUnseeded('getWorkPlan', stream);
    return this.records.get(stream)?.workPlan ?? EMPTY_WORK_PLAN;
  }

  private patchMetaMemory(
    stream: StreamTabId,
    patch: Partial<StreamTabMeta>,
  ): StreamTabMeta {
    const record = this.getOrCreateRecord(stream);
    const next: StreamTabMeta = {
      ...(record.meta ?? {}),
      ...patch,
      schemaVersion: STREAM_TAB_META_SCHEMA_VERSION,
    };
    record.meta = next;
    return next;
  }

  private writeMeta(stream: StreamTabId, next: StreamTabMeta): void {
    // Persist every explicitly-set field (`!== undefined`, not falsy) so
    // on-disk and in-memory never diverge. The sidecar carries only the FK
    // pair below; `description` is never persisted here — its authority is
    // `ExecutionMeta.description` (#9590), and the legacy sidecar mirror was
    // deliberately retired early with the run-classification consolidation.
    const file: StreamTabMeta = {
      schemaVersion: STREAM_TAB_META_SCHEMA_VERSION,
      ...(next.executionId !== undefined && { executionId: next.executionId }),
      ...(next.parentStreamId !== undefined && {
        parentStreamId: next.parentStreamId,
      }),
    };
    this.write(stream, STREAM_DATA_KEYS.META, file);
  }

  private queueMetaPatch(
    stream: StreamTabId,
    patch: Partial<StreamTabMeta>,
  ): void {
    this.patchMetaMemory(stream, patch);
    this.getOrCreateRecord(stream).metaOverlay = true;
    const applied = this.mutate(stream, () => {
      this.writeMeta(stream, this.patchMetaMemory(stream, patch));
      return true;
    });
    if (applied) this.getOrCreateRecord(stream).metaOverlay = false;
  }

  // ==========================================================================
  // Meta accessors, setters, and queries
  // ==========================================================================

  /**
   * Set the stream's run config, optionally with the execution id, in a SINGLE
   * meta.json write (callers that have both should pass both so meta isn't
   * written twice).
   */
  private setRunConfig(
    stream: StreamTabId,
    config: AgentConfig,
    executionId?: ExecutionId,
  ): void {
    const record = this.getOrCreateRecord(stream);
    if (
      executionId &&
      record.runExecutionId &&
      record.runExecutionId !== executionId
    ) {
      // A config for a new execution the store never saw `run.start` for:
      // the previous run's identity and description are not this run's.
      // Identity stays absent (renders pending) until `run.start` or a seed
      // reads the durable `ExecutionMeta.identity` — never synthesized here.
      record.runIdentity = undefined;
      record.userFollowUpSupport = undefined;
      record.description = undefined;
      record.summaryMetaHydrationFallback = undefined;
    }
    record.summaryMetaHydrationFallback = withoutSummaryMetaFields(
      record.summaryMetaHydrationFallback,
      ['agentCategory', 'model', 'workingDirectory', 'command'],
    );
    record.runConfig = config;
    if (executionId) record.runExecutionId = executionId;
    this.queueMetaPatch(stream, executionId ? { executionId } : {});
    this.publishSummaryMeta(stream);
  }

  /**
   * Persist the immutable identity emitted at run start. Later `run.config`
   * facts may change model or instruction, but cannot rename or recategorize
   * the stream.
   */
  private setRunStart(
    stream: StreamTabId,
    executionId: ExecutionId,
    identity: RunIdentity,
    userFollowUpSupport: UserFollowUpSupport | undefined,
  ): void {
    const record = this.getOrCreateRecord(stream);
    // The config of the run this stream just left is not this run's config;
    // `run.config` follows `run.start` with the new one. A config carrying no
    // identity yet is this run's until something says otherwise, so only a
    // KNOWN previous execution drops it.
    const previous = record.runExecutionId;
    if (previous && previous !== executionId) {
      record.runConfig = undefined;
      record.description = undefined;
      record.summaryMetaHydrationFallback = undefined;
    }
    record.summaryMetaHydrationFallback = withoutSummaryMetaFields(
      record.summaryMetaHydrationFallback,
      ['identity', 'userFollowUpSupport'],
    );
    record.runExecutionId = executionId;
    record.runIdentity = identity;
    record.userFollowUpSupport = userFollowUpSupport;
    this.queueMetaPatch(stream, { executionId });
    this.publishSummaryMeta(stream);
  }

  private setParentStream(
    child: StreamTabId,
    parent: StreamTabId | null | undefined,
  ): void {
    this.queueMetaPatch(child, { parentStreamId: parent ?? undefined });
    this.publishSummaryMeta(child);
  }

  /**
   * Record the display description in memory only (#9590 Stage 6). The
   * authority is `ExecutionMeta.description` (A4), which the event's emitters
   * persist before emitting — this store never writes a sidecar description
   * copy for current records.
   */
  private setDescription(stream: StreamTabId, description: string): void {
    const record = this.getOrCreateRecord(stream);
    record.description = description;
    record.summaryMetaHydrationFallback = withoutSummaryMetaFields(
      record.summaryMetaHydrationFallback,
      ['description'],
    );
    this.publishSummaryMeta(stream);
  }

  /**
   * Canonical immutable run record projected from live facts or hydrated from
   * the execution record named by the stream sidecar. All five fields share
   * that execution owner and replacement lifecycle.
   */
  getRunMetadata(stream: StreamTabId): RunMetadata {
    this.warnIfUnseeded('getRunMetadata', stream);
    const record = this.records.get(stream);
    return Object.freeze({
      executionId: record?.runExecutionId,
      identity: record?.runIdentity,
      userFollowUpSupport: record?.userFollowUpSupport,
      config: record?.runConfig,
      description: record?.description,
    });
  }

  /** Streams with persisted sidecars under `streamData/`. */
  async listPersistedStreams(): Promise<StreamTabId[]> {
    return this.listStreamsUnder(STREAM_DATA_DIR);
  }

  /** Streams left in reversible staging by an interrupted deletion. */
  async listStagedDeletions(): Promise<StreamTabId[]> {
    return this.listStreamsUnder(STREAM_DATA_DELETION_DIR);
  }

  /**
   * Execution id recorded in a stream sidecar's `meta.json`, without seeding
   * memory or reading the stream's other sidecar files. Callers that scan
   * every persisted stream (bulk admin sweeps in `SessionStores`) only ever
   * need this one field, so this reads just `meta.json` rather than the full
   * 6-file `readStreamData()`.
   */
  async readPersistedExecutionId(
    stream: StreamTabId,
  ): Promise<ExecutionId | undefined> {
    return (await readMeta(this.kv(stream)))?.executionId;
  }

  /**
   * Whether a stream has a persisted `workPlan.json` sidecar — an existence
   * check only (a single stat via `KVStore.exists`), not a read.
   */
  async hasPersistedWorkPlan(stream: StreamTabId): Promise<boolean> {
    return this.kv(stream).exists(STREAM_DATA_KEYS.WORK_PLAN);
  }

  getParentStreamId(stream: StreamTabId): StreamTabId | undefined {
    this.warnIfUnseeded('getParentStreamId', stream);
    return this.records.get(stream)?.meta?.parentStreamId;
  }

  /** Find and seed children before their canonical parent-detach facts emit. */
  private async detachPersistedChildren(
    parent: StreamTabId,
  ): Promise<StreamTabId[]> {
    await this.flush();
    const children: StreamTabId[] = [];
    for (const stream of await this.listPersistedStreams()) {
      if (stream === parent) continue;
      let meta;
      try {
        meta = await readMeta(this.kv(stream));
      } catch (error) {
        // An unreadable sidecar proves nothing about this stream's parent;
        // treat it as unrelated so one bad file cannot block the detach
        // sweep for every other child.
        log.warn(
          `Skipping unreadable sidecar meta for stream ${stream} during child detach.`,
          { data: error },
        );
        continue;
      }
      if (meta?.parentStreamId === parent) {
        children.push(stream);
      }
    }
    await this.preload(children);
    return children.filter((child) => this.getParentStreamId(child) === parent);
  }

  /** Read-only view of stream→executionId for waiting-stream detection. */
  getExecutionIdMap(): ReadonlyMap<StreamTabId, ExecutionId> {
    const map = new Map<StreamTabId, ExecutionId>();
    for (const [stream, record] of this.records) {
      // Per-record loudness: a resident record without established disk
      // provenance may be missing its persisted executionId here. Streams
      // with no record at all are this accessor's contract (callers merge
      // `readPersistedExecutionId` for those), so only resident-but-unknown
      // records warrant a warning.
      this.warnIfUnseeded('getExecutionIdMap', stream);
      const executionId = record.runExecutionId;
      if (executionId) map.set(stream, executionId);
    }
    return map;
  }

  // ==========================================================================
  // Writes — serialized per (stream, category), evict-safe
  // ==========================================================================

  private writeWorkPlan(stream: StreamTabId, plan: WorkPlanSnapshot): void {
    this.write(
      stream,
      STREAM_DATA_KEYS.WORK_PLAN,
      PersistedWorkPlanSchema.parse({
        todos: plan.todos,
        plan: plan.plan,
        planSummary: plan.planSummary,
      }),
    );
  }

  private write(stream: StreamTabId, key: string, value: unknown): void {
    // A staged deletion owns the stream's namespace, so it takes the value
    // into its transactional buffer instead of letting it reach disk.
    if (this.deletions.bufferWrite(stream, key, value)) return;
    this.writeUnbuffered(stream, key, value);
  }

  private writeUnbuffered(
    stream: StreamTabId,
    key: string,
    value: unknown,
  ): void {
    const chainKey = `${stream}::${key}`;
    const write = { stream, key, value } satisfies DirtySidecarWrite;
    this.dirtyWrites.set(chainKey, write);
    void this.persistDirtyWrite(chainKey, write).catch((err: unknown) =>
      log.warn(
        `Failed to persist ${key}.json for stream ${stream}; sidecar remains dirty.`,
        { data: err },
      ),
    );
  }

  private async persistDirtyWrite(
    chainKey: string,
    write: DirtySidecarWrite,
  ): Promise<void> {
    // A newer write or staged deletion can revoke this retry before it enters
    // the per-key queue. Only the current dirty owner may recreate that queue.
    if (this.dirtyWrites.get(chainKey) !== write) return;
    await this.queueWrite(write.stream, write.key, write.value);
    if (this.dirtyWrites.get(chainKey) === write) {
      this.dirtyWrites.delete(chainKey);
    }
  }

  /** Queue a sidecar write and expose its completion to transactional callers. */
  private queueWrite(
    stream: StreamTabId,
    key: string,
    value: unknown,
  ): Promise<void> {
    const chainKey = `${stream}::${key}`;
    const version = this.streamVersion(stream);
    const mutex = this.writeMutexes.get(chainKey) ?? new Mutex();
    this.writeMutexes.set(chainKey, mutex);
    return mutex.runExclusive(() => {
      // Eviction guard: `evict()`/`deleteStream()` drop this chain key. A
      // write queued before that must NOT fire afterward, or a late `kv()`
      // would re-create the `streamData/{id}/` dir `deleteDir()` just removed.
      if (!this.writeMutexes.has(chainKey)) return;
      if (this.streamVersion(stream) !== version) return;
      return this.kv(stream).write(key, value);
    });
  }

  private writeBelongsToStream(
    chainKey: string,
    stream?: StreamTabId,
  ): boolean {
    return stream === undefined || chainKey.startsWith(`${stream}::`);
  }

  private async waitForWrites(stream?: StreamTabId): Promise<void> {
    await Promise.all(
      [...this.writeMutexes]
        .filter(([chainKey]) => this.writeBelongsToStream(chainKey, stream))
        .map(([, mutex]) => mutex.waitForUnlock()),
    );
  }

  private cancelPendingWritesForStream(stream: StreamTabId): Promise<void>[] {
    const prefix = `${stream}::`;
    const pending: Promise<void>[] = [];
    for (const [key, mutex] of this.writeMutexes) {
      if (!key.startsWith(prefix)) continue;
      const dirty = this.dirtyWrites.get(key);
      // Hand the cancelled value to a staged deletion, which keeps it buffered
      // until the transaction settles. This loop is synchronous, so which
      // deletion (if any) owns the stream cannot change while it runs.
      if (dirty)
        this.deletions.captureDirtyWrite(stream, dirty.key, dirty.value);
      this.dirtyWrites.delete(key);
      pending.push(mutex.waitForUnlock());
      this.writeMutexes.delete(key);
    }
    return pending;
  }

  private dirtyWriteEntries(
    stream?: StreamTabId,
  ): [string, DirtySidecarWrite][] {
    return [...this.dirtyWrites].filter(([chainKey]) =>
      this.writeBelongsToStream(chainKey, stream),
    );
  }

  private async retryDirtyWrites(stream?: StreamTabId): Promise<void> {
    await this.waitForWrites(stream);

    for (let attempt = 0; attempt < MAX_DIRTY_WRITE_RETRIES; attempt++) {
      const dirty = this.dirtyWriteEntries(stream);
      if (dirty.length === 0) return;
      await Promise.allSettled(
        dirty.map(([chainKey, write]) =>
          this.persistDirtyWrite(chainKey, write),
        ),
      );
    }

    const remaining = this.dirtyWriteEntries(stream).length;
    if (remaining > 0) {
      throw new DirtySidecarWritesError(
        `Sidecar writes remain dirty after ${MAX_DIRTY_WRITE_RETRIES} retries; ` +
          `${remaining} sidecar write(s) remain dirty.`,
      );
    }
  }

  private unseenSeedChains(
    completed: ReadonlySet<Promise<void>>,
  ): Promise<void>[] {
    return [...this.records.values()]
      .map((record) => record.seedChain)
      .filter(
        (chain): chain is Promise<void> =>
          chain !== undefined && !completed.has(chain),
      );
  }

  private async drainSeedChains(
    completed: Set<Promise<void>>,
    failures: unknown[],
  ): Promise<void> {
    while (true) {
      const seeds = this.unseenSeedChains(completed);
      if (seeds.length === 0) return;
      for (const seed of seeds) completed.add(seed);
      for (const result of await Promise.allSettled(seeds)) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
    }
  }

  /** Await deferred (seed-gated) mutations, then all in-flight writes. */
  async flush(): Promise<void> {
    const failures: unknown[] = [];
    const completedSeeds = new Set<Promise<void>>();
    let dirtyWritesDurable = false;

    // Seed work can rebind a record's chain while an earlier chain is awaited.
    // Reach seed quiescence before taking the one deletion-recovery snapshot.
    await this.drainSeedChains(completedSeeds, failures);

    failures.push(...(await this.deletions.recoverPendingRollbacks()));

    // Recovery and ordinary writes may allow another seed-gated mutation to
    // start. Drain those chains and their writes, but do not rerun recovery or
    // duplicate a failure from the recovery snapshot above.
    while (true) {
      await this.drainSeedChains(completedSeeds, failures);
      try {
        await this.retryDirtyWrites();
        dirtyWritesDurable = true;
      } catch (error) {
        dirtyWritesDurable = false;
        failures.push(error);
        break;
      }
      if (this.unseenSeedChains(completedSeeds).length === 0) break;
    }

    const remainingFailures = dirtyWritesDurable
      ? failures.filter((error) => !(error instanceof DirtySidecarWritesError))
      : failures;
    throwAggregated(remainingFailures, 'Snapshot flush failed');
  }

  // ==========================================================================
  // Read / load — disk reads delegate to the pure `streamSnapshotRead` module
  // ==========================================================================

  /**
   * Reassemble the durable display snapshot for a stream. Once a stream is
   * seeded (via {@link load} or a progress event) its in-memory accumulators
   * are the single source of truth — they already hold the disk state plus any
   * newer deltas — so we assemble from memory and skip a redundant disk re-read.
   * The CLI resume path calls `load` then `read` back-to-back. Only an unseeded
   * stream, such as a display-only read that was never resumed, hits disk.
   */
  async read(streamId: StreamTabId): Promise<StreamSnapshot> {
    if (await this.awaitSeeded(streamId)) {
      return this.snapshotFromMemory(streamId);
    }
    return assembleSnapshot(streamId, await readStreamData(this.kv(streamId)));
  }

  /**
   * Await any in-flight seed for a stream and report whether its in-memory
   * accumulators are authoritative afterward.
   */
  private async awaitSeeded(streamId: StreamTabId): Promise<boolean> {
    // Awaiting `undefined` (no in-flight seed) resolves immediately.
    await this.records.get(streamId)?.seedChain;
    return this.hasDiskProvenance(streamId);
  }

  /**
   * Assemble the snapshot from already-hydrated in-memory accumulators.
   * Clones the round-indexed records (same as the public getOutputFiles/
   * getMissingOutputs/getCompileFailures accessors) so a caller reassigning
   * or pushing/splicing a returned per-round array can't corrupt these live
   * accumulators. Per cloneRoundIndexed's own contract, item objects
   * themselves are not cloned — they're treated as immutable value objects,
   * same as every other schema-derived type in this codebase.
   */
  private snapshotFromMemory(streamId: StreamTabId): StreamSnapshot {
    const record = this.records.get(streamId);
    return assembleSnapshot(streamId, {
      meta: record?.meta,
      outputFiles: cloneRoundIndexed(record?.outputFiles),
      missingOutputs: cloneRoundIndexed(record?.missingOutputs),
      compileFailures: cloneRoundIndexed(record?.compileFailures),
      usage: record?.usage ?? new Map(),
      usageUnparsed: record?.usageUnparsed ?? new Map(),
      workPlan: this.getWorkPlan(streamId),
    });
  }

  /**
   * A stream's output files (round → files). Served from the seeded in-memory
   * accumulators when available — the single source of truth — so a caller that
   * already `load()`ed the stream doesn't re-read all sidecars from disk; only
   * an unseeded stream falls back to a disk read.
   */
  async readOutputFiles(
    streamId: StreamTabId,
  ): Promise<RoundIndexed<OutputFileInfo>> {
    if (await this.awaitSeeded(streamId)) {
      return this.getOutputFiles(streamId);
    }
    return (await readStreamData(this.kv(streamId))).outputFiles;
  }

  /**
   * Authoritatively hydrate the in-memory accumulators from the stream-log set.
   * Streams not present in `streamIds` are evicted; streams that are present are
   * refreshed from disk even if this store had seeded them before, so a reused
   * progress-view backend cannot carry stale state across reload/workspace
   * boundaries. Mutations that arrive during the refresh queue behind the same
   * per-stream chain and apply after the disk snapshot.
   */
  async load(streamIds: readonly StreamTabId[]): Promise<void> {
    this.evictStreamsExcept(new Set(streamIds));
    await this.seedStreams(streamIds);
  }

  /**
   * Warm selected stream sidecars without claiming that `streamIds` is the full
   * stream set. Use this when a host only has a partial rail snapshot at
   * startup; later mutations for other streams must still seed from disk before
   * writing.
   */
  async preload(streamIds: readonly StreamTabId[]): Promise<void> {
    await this.seedStreams(streamIds);
  }

  private async seedStreams(streamIds: readonly StreamTabId[]): Promise<void> {
    await pMap(streamIds, (streamId) => this.refreshSeed(streamId), {
      concurrency: SEED_IO_CONCURRENCY,
    });
  }

  private evictStreamsExcept(keep: ReadonlySet<StreamTabId>): void {
    for (const stream of [...this.records.keys()]) {
      if (!keep.has(stream)) this.evict(stream);
    }
  }

  private refreshSeed(stream: StreamTabId): Promise<void> {
    const version = this.streamVersion(stream);
    const record = this.getOrCreateRecord(stream);
    const refreshBaseline = record.seedRefreshBaseline ?? record.diskState;
    record.seedRefreshBaseline = refreshBaseline;
    const refreshGeneration = ++record.seedRefreshGeneration;
    record.diskState = 'unknown';
    const prev = record.seedChain?.catch(() => undefined) ?? Promise.resolve();
    const work = prev.then(async () => {
      if (this.streamVersion(stream) !== version) return;
      await this.retryDirtyWrites(stream);
      if (this.streamVersion(stream) !== version) return;
      this.invalidateKvHandles(stream);
      await this.seedFromDisk(stream, version);
    });
    const next = work.then(
      () => {
        const current = this.records.get(stream);
        if (
          current?.seedRefreshGeneration === refreshGeneration &&
          this.streamVersion(stream) === version
        ) {
          current.seedRefreshBaseline = undefined;
        }
      },
      (error: unknown) => {
        const current = this.records.get(stream);
        if (
          current?.seedRefreshGeneration === refreshGeneration &&
          this.streamVersion(stream) === version
        ) {
          current.diskState = refreshBaseline;
          current.seedRefreshBaseline = undefined;
          if (refreshBaseline !== 'unknown') {
            this.persistEagerOverlays(stream, current);
          }
          if (current.seedChain === next) current.seedChain = undefined;
        }
        throw error;
      },
    );
    record.seedChain = next;
    return next;
  }

  private async hydrateRunStateFromMeta(
    stream: StreamTabId,
    meta: StreamTabMeta,
  ): Promise<HydratedRunState> {
    const executionId = meta.executionId;
    let identity: RunIdentity | undefined;
    let userFollowUpSupport: UserFollowUpSupport | undefined;
    let description: string | undefined;
    let authorityReadComplete = true;

    if (executionId) {
      let config: AgentConfig | null = null;
      try {
        const store = getExecutionStore(executionId);
        const [execMeta, execConfig] = await Promise.all([
          store.readMeta(),
          store.readConfig(),
        ]);
        // Identity comes only from the stamped execution row. Pre-identity
        // rows (registered before identity stamping) lost their reader per
        // #9590 Stage 7: hydrate without an identity, loudly — never
        // reconstruct one from stream-id prefixes or config.
        identity = execMeta?.identity;
        userFollowUpSupport = execMeta?.userFollowUpSupport;
        if (execMeta && !identity && !this.preIdentityWarned.has(stream)) {
          this.preIdentityWarned.add(stream);
          log.warn(
            `Stream ${stream} maps to pre-identity execution row ${executionId}; hydrating without a run identity (reader retired per #9590 Stage 7)`,
          );
        }
        description = execMeta?.description;
        config = execConfig;
      } catch (error) {
        authorityReadComplete = false;
        log.warn(`Could not read execution record for stream ${stream}.`, {
          data: { stream, executionId, error },
        });
      }
      if (config) {
        return {
          authorityReadComplete,
          config,
          identity,
          userFollowUpSupport,
          description,
        };
      }
    }

    return {
      authorityReadComplete,
      identity,
      userFollowUpSupport,
      description,
    };
  }

  /** Seed the in-memory accumulators for one stream. */
  private async applyStreamData(
    stream: StreamTabId,
    data: StreamData,
    provenance: Exclude<DiskState, 'unknown'>,
  ): Promise<void> {
    const version = this.streamVersion(stream);
    const record = this.getOrCreateRecord(stream);
    const metaOverlay = record.metaOverlay ? record.meta : undefined;
    const usageOverlayToReplay = new Map(record.overlays.usage);
    const sidecarsToWrite = new Set<OverlaySidecarKey>();

    record.outputFiles = data.outputFiles;
    record.missingOutputs = data.missingOutputs;
    record.compileFailures = data.compileFailures;
    record.usage = new Map([...data.usage].filter(([, v]) => !isEmptyUsage(v)));
    record.usageUnparsed = new Map(data.usageUnparsed);
    record.workPlan = data.workPlan;

    const meta = metaOverlay
      ? { ...(data.meta ?? {}), ...metaOverlay }
      : data.meta;
    record.meta = meta;
    record.metaOverlay = false;

    // Disk meta names which execution the stream is on, so a memory pair for a
    // DIFFERENT execution (or for any execution once meta names none) is a
    // handoff another writer completed: both halves go, and hydration installs
    // a coherent pair instead of one half of each run. For the execution meta
    // does name, the two halves have different owners. The run identity is
    // immutable, so the live `run.start` outranks anything hydration can
    // synthesize from config. The config is mutable and persisted, so this seed
    // re-reads it — another host can switch the model without this store seeing
    // `run.config`, and `load()` promises a refresh — and yields only to a live
    // config newer than the snapshot: one still pending at seed start, or one
    // that lands during the hydration below. A config an EARLIER seed left in
    // memory is not newer, and is what goes stale.
    //
    // `record` rides across the hydration await: records are mutated in place,
    // never replaced. Never re-resolve it via `getOrCreateRecord` here — if the
    // stream was evicted during the await, that would resurrect a record for a
    // deleted stream and defeat `writeMergedSidecars`' eviction check (#8226);
    // an orphaned `record` is mutated harmlessly and never written.
    const executionId = meta?.executionId;
    const previousExecutionId = record.runExecutionId;
    if (!meta || previousExecutionId !== executionId) {
      record.runExecutionId = undefined;
      record.runIdentity = undefined;
      record.userFollowUpSupport = undefined;
      record.runConfig = undefined;
      // The display description belongs to the execution it was projected
      // from (#9590 Stage 6); when identity changes hands, drop it with the
      // pair and invalidate any authority read already in flight.
      record.description = undefined;
      record.summaryMetaHydrationFallback = undefined;
    }
    if (meta) {
      const pendingLiveWrite = metaOverlay !== undefined;
      const configBeforeHydration = record.runConfig;
      const hydrated = await this.hydrateRunStateFromMeta(stream, meta);
      const mirroredMeta = this.summaryMetaSource?.(stream);
      const mirroredExecutionId =
        mirroredMeta?.executionId ?? previousExecutionId;
      if (
        !hydrated.authorityReadComplete &&
        mirroredExecutionId === executionId
      ) {
        record.summaryMetaHydrationFallback = withoutSummaryMetaFields(
          mirroredMeta,
          ['executionId', 'parentStreamId'],
        );
      } else {
        record.summaryMetaHydrationFallback = undefined;
      }
      if (this.streamVersion(stream) !== version) return;
      // Re-checked after the await: a `run.start` for another execution can
      // land during it, and this seed's pair belongs to the run it read.
      const liveExecutionId = record.runExecutionId;
      if (liveExecutionId === undefined || liveExecutionId === executionId) {
        record.runExecutionId ??= executionId;
        record.runIdentity ??= hydrated.identity;
        record.userFollowUpSupport ??= hydrated.userFollowUpSupport;
        // The authority's description rides the same execution-meta read as
        // identity — free on every seed. A live `updateStreamDescription`
        // that landed during the await owns the field by presence.
        if (record.description === undefined) {
          record.description = hydrated.description;
        }
        const liveRunConfig =
          record.runConfig !== undefined &&
          (pendingLiveWrite || record.runConfig !== configBeforeHydration);
        if (!liveRunConfig) {
          record.runConfig = hydrated.config ?? record.runConfig;
        }
      }
    }

    const { overlays } = record;
    if (overlays.outputFiles) {
      this.applyRoundPatch((r) => r.outputFiles, record, overlays.outputFiles);
      sidecarsToWrite.add(OVERLAY_TO_SIDECAR_KEY.outputFiles);
      overlays.outputFiles = undefined;
    }
    if (overlays.missingOutputs) {
      if (overlays.missingOutputs.reset) record.missingOutputs = {};
      this.applyRoundPatch(
        (r) => r.missingOutputs,
        record,
        overlays.missingOutputs.patch,
      );
      sidecarsToWrite.add(OVERLAY_TO_SIDECAR_KEY.missingOutputs);
      overlays.missingOutputs = undefined;
    }
    if (overlays.compileFailures) {
      this.applyRoundPatch(
        (r) => r.compileFailures,
        record,
        overlays.compileFailures,
      );
      sidecarsToWrite.add(OVERLAY_TO_SIDECAR_KEY.compileFailures);
      overlays.compileFailures = undefined;
    }
    if (overlays.usage) {
      for (const [storageKey, delta] of usageOverlayToReplay) {
        this.applyUsageDeltaMemory(record, storageKey, delta);
      }
      sidecarsToWrite.add(OVERLAY_TO_SIDECAR_KEY.usage);
      overlays.usage = undefined;
    }
    if (overlays.workPlan) {
      const overlay = overlays.workPlan;
      if (overlay.todos !== undefined) {
        record.workPlan = { ...record.workPlan, todos: [...overlay.todos] };
      }
      if (overlay.plan !== undefined) {
        record.workPlan = {
          ...record.workPlan,
          plan: overlay.plan,
          planSummary: overlay.plan
            ? planSummaryLine(overlay.plan.objective)
            : null,
        };
      }
      sidecarsToWrite.add(OVERLAY_TO_SIDECAR_KEY.workPlan);
      overlays.workPlan = undefined;
    }
    record.diskState = provenance;
    this.writeMergedSidecars(stream, record, sidecarsToWrite);
    // Hydration republishes the metadata mirror: the deep-equal gate makes an
    // unchanged projection free, and this lazily backfills old summaries
    // (#9947). After an incomplete read, the fallback preserves fields owned
    // by the same execution while current sidecar fields still refresh; after
    // a handoff, only facts belonging to the new execution are published.
    if (this.records.get(stream) === record) {
      this.publishSummaryMeta(stream);
    }
  }

  /** Persist sidecars from merged memory after seeding and overlays converge. */
  private writeMergedSidecars(
    stream: StreamTabId,
    record: StreamRecord,
    keys: Iterable<OverlaySidecarKey>,
  ): void {
    // `record` rode across `applyStreamData`'s hydration await. Identity —
    // not mere presence — against the live map entry: eviction during the
    // await orphans `record`, and a concurrent eager mutation can already have
    // re-created a fresh entry, so a presence check would still let orphaned
    // seed state resurrect the deleted `streamData/{id}/` dir on disk (#8226).
    if (this.records.get(stream) !== record) return;
    for (const key of keys) {
      switch (key) {
        case STREAM_DATA_KEYS.OUTPUT_FILES:
          this.writeOutputFiles(stream);
          break;
        case STREAM_DATA_KEYS.USAGE_STATS:
          this.writeUsage(stream);
          break;
        case STREAM_DATA_KEYS.MISSING_OUTPUTS:
          this.write(stream, key, { ...record.missingOutputs });
          break;
        case STREAM_DATA_KEYS.COMPILE_FAILURES:
          this.write(stream, key, { ...record.compileFailures });
          break;
        case STREAM_DATA_KEYS.WORK_PLAN:
          this.writeWorkPlan(stream, record.workPlan);
          break;
      }
    }
  }

  /** Persist eager in-memory patches when a refresh falls back to prior state. */
  private persistEagerOverlays(
    stream: StreamTabId,
    record: StreamRecord,
  ): void {
    if (record.metaOverlay) {
      if (record.meta) this.writeMeta(stream, record.meta);
      record.metaOverlay = false;
    }

    const keys = new Set<OverlaySidecarKey>();
    const { overlays } = record;
    for (const [field, key] of Object.entries(OVERLAY_TO_SIDECAR_KEY) as [
      keyof OverlayPatches,
      OverlaySidecarKey,
    ][]) {
      if (!overlays[field]) continue;
      keys.add(key);
      overlays[field] = undefined;
    }
    this.writeMergedSidecars(stream, record, keys);
  }
}
