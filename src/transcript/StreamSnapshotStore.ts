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

import pMap from 'p-map';
import { z } from 'zod';

import { getExecutionStore } from '@agent/storage';
import type { AgentEvent } from '@agent/trace';
import { flowKey } from '@agent/node/persistedFlow';
import {
  inspectExecutionLease,
  type ExecutionLeasePresence,
} from '@agent/storage/executionLease';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { isFileNotFoundError } from '@common/errors';
import { KVStore } from '@common/storage/KVStore';
import { createLog } from '@logger/logUtils';
import {
  CompileFailureSchema,
  cloneRoundIndexed,
  EMPTY_ROUND_INDEXED,
  emptyUsageStats,
  isEmptyUsage,
  OutputFileInfoListSchema,
  PersistedWorkPlanSchema,
  STREAM_SNAPSHOT_SCHEMA_VERSION,
  STREAM_TAB_META_SCHEMA_VERSION,
  planSummaryLine,
  RoundKeySchema,
  sumUsageStats,
  TokenUsageStatsParsingBaseSchema,
  type CompileFailure,
  type ExecutionId,
  type ExtendedTokenUsageStats,
  type OutputFileInfo,
  type RunIdentity,
  type RunOutcome,
  type Plan,
  type ReadonlyRoundIndexed,
  type RoundIndexed,
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
import { getOrCreatePQueue } from '@utils/core/perKeyQueue';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { StorageFS } from '@utils/files/storageFS';
import { isDirectory } from '@utils/files/fsEntryType';

import { ResidentStreamRegistry } from './ResidentStreamRegistry';
import {
  DirtySidecarWritesError,
  SidecarWriteCoordinator,
  type SidecarWriteHost,
} from './SidecarWriteCoordinator';
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
import type PQueue from 'p-queue';
import type { StreamSummaryMeta } from './StreamSummaryCacheStore';

const log = createLog('StreamSnapshotStore');

/** Shared empty view for a stream with no per-run usage recorded yet. */
const EMPTY_RUN_USAGE: ReadonlyMap<string, TokenUsageStats> = new Map();

/** Bounded fan-out for seeding many streams' sidecars, so startup does not
 *  open a file handle per tab. */
const SEED_IO_CONCURRENCY = 8;

/** Re-drain attempts before a record with still-pending writes stays resident. */
const MAX_EVICTION_DRAIN_ATTEMPTS = 3;

/**
 * Per-field provenance of one stream's work plan: whether the in-memory value
 * for that field has an established origin — a seeded disk baseline, or a live
 * replacement applied ahead of one — rather than an unread default. Todos and
 * plan are whole-value replacements, so a live overlay for either establishes
 * that field on its own; every other accumulator is a delta over a base only a
 * baseline can supply. Read live via {@link StreamSnapshotStore.workPlanProvenance}.
 */
export interface WorkPlanProvenance {
  readonly plan: boolean;
  readonly todos: boolean;
}

/** A failed preload together with the in-memory state that remains usable. */
export class StreamSnapshotPreloadError extends Error {
  override readonly name = 'StreamSnapshotPreloadError';

  constructor(
    cause: unknown,
    readonly streamId: StreamTabId,
    /**
     * The whole in-memory record is authoritative: a prior seed or an
     * existence probe already established this stream's disk baseline, so
     * every accumulator holds the complete field value and not just a delta.
     */
    readonly baselineEstablished: boolean,
    readonly workPlanProvenance: WorkPlanProvenance,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

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

type OutputFilesPatch = Map<number, OutputFileInfo[] | null>;
interface HydratedRunState {
  /**
   * Why the execution authority could not be read, or `undefined` when it
   * was read completely. One field rather than a boolean plus a cause: a
   * reader that shows the failure needs the words, and a second field could
   * disagree with the first.
   */
  authorityFailure?: string;
  config?: AgentConfig;
  identity?: RunIdentity;
  userFollowUpSupport?: UserFollowUpSupport;
  description?: string;
  /** Persisted run outcome from `ExecutionMeta.outcome`; absent while a run
   *  is live and forever for a run that crashed before finalizing. */
  outcome?: RunOutcome;
}

/**
 * The display-only half of a run's read-time tuple. Deliberately NOT part of
 * {@link HydratedRunState}: the metadata restore in `applyStreamData` runs
 * with a record's accumulators holding raw disk state until its overlays are
 * replayed, so nothing that merely feeds a status pill may lengthen that
 * window. This probe is started beside the metadata read and awaited once the
 * record is whole again.
 */
interface RunPhaseProbe {
  checkpointPresent?: boolean;
  lease?: ExecutionLeasePresence;
  /** Why the probe could not answer, if it could not. */
  failure?: string;
}

/**
 * What a hydration learned about the run a stream last carried: enough for a
 * reader to say what happened to a stream with no live flow context in this
 * process, and nothing more.
 *
 * Held OUTSIDE the stream record, in a small always-resident map, for the
 * reason bounded residency exists (#9947): a rail that wants every tab's
 * phase would otherwise have to keep every tab's whole sidecar record
 * resident. Four small fields per stream survive the record; the accumulators
 * behind them do not. In memory only — nothing here is written to a sidecar
 * or a summary file, and a fresh process learns it all again by hydrating.
 *
 * Display-only. Each field was true at the instant the stream hydrated, so a
 * caller about to WRITE (open, resume, delete) re-reads the authority under
 * the lease instead of trusting them — a process-local mirror cannot observe
 * another host's finalize (see `listExecutions`' own note on that rule).
 */
export interface RunPhaseFacts {
  /** `ExecutionMeta.outcome`: absent for a run that never finalized. */
  readonly outcome?: RunOutcome;
  /** Whether a resumable flow checkpoint file exists (existence, not validity). */
  readonly checkpointPresent?: boolean;
  /** Who held the execution lease when this stream hydrated. */
  readonly lease?: ExecutionLeasePresence;
  /** Why this stream's execution authority could not be read, if it could not. */
  readonly authorityFailure?: string;
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
 * The mirrored fields one execution owns, and which a handoff to a different
 * execution therefore invalidates. Everything else in `StreamSummaryMeta` —
 * `parentStreamId`, `cumulativeUsage` — describes the stream across every run
 * it has hosted and survives the handoff.
 */
const EXECUTION_SCOPED_SUMMARY_META_FIELDS = [
  'identity',
  'executionId',
  'userFollowUpSupport',
  'agentCategory',
  'description',
  'model',
  'workingDirectory',
  'command',
] as const satisfies readonly (keyof StreamSummaryMeta)[];

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

/** Element type per round-keyed accumulator field; keys define {@link RoundKeyedField}. */
interface RoundFieldElement {
  outputFiles: OutputFileInfo;
  missingOutputs: string;
  compileFailures: CompileFailure;
}
type RoundKeyedField = keyof RoundFieldElement;

/**
 * Wire→domain normalizer per round-keyed field, applied to each round's raw
 * value by {@link StreamSnapshotStore.applyRoundFieldFact}. Returning `null`
 * deletes the round's entry; `missingOutputs` deliberately keeps `[]` so an
 * empty list overwrites the round (clearing its missing set) rather than
 * deleting it.
 */
const ROUND_FIELD_NORMALIZERS: {
  [K in RoundKeyedField]: (raw: unknown) => RoundFieldElement[K][] | null;
} = {
  outputFiles: (raw) => {
    const normalized = OutputFileInfoListSchema.parse(
      Array.isArray(raw) ? raw : [],
    );
    return normalized.length === 0 ? null : normalized;
  },
  missingOutputs: (raw) =>
    z.array(z.string()).parse(Array.isArray(raw) ? raw : []),
  compileFailures: (raw) => {
    const normalized = CompileFailureSchema.array().parse(
      Array.isArray(raw) ? raw : [],
    );
    return normalized.length === 0 ? null : normalized;
  },
};

/** Record accessor per round-keyed field, typed so a generic caller keeps the element type. */
const ROUND_FIELD_OF: {
  [K in RoundKeyedField]: (
    record: StreamRecord,
  ) => RoundIndexed<RoundFieldElement[K]>;
} = {
  outputFiles: (record) => record.outputFiles,
  missingOutputs: (record) => record.missingOutputs,
  compileFailures: (record) => record.compileFailures,
};

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
  missingOutputs: Map<number, string[] | null>;
  compileFailures: Map<number, CompileFailure[] | null>;
  usage: Map<ExecutionId, TokenUsageStats>;
  workPlan: WorkPlanOverlay;
}

/**
 * Overlay field → sidecar key. The single enumeration of which overlay patch
 * flushes to which sidecar: `writeRoundKeyedField` derives its sidecar name
 * here and `persistEagerOverlays` enumerates the overlay fields through it,
 * and the `satisfies` makes a new {@link OverlayPatches} field a compile
 * error here until its sidecar is named. The write sets themselves carry the
 * overlay field name — `writeMergedSidecars` dispatches on it directly, so
 * nothing converts field → sidecar key → field.
 */
const OVERLAY_TO_SIDECAR_KEY = {
  outputFiles: STREAM_DATA_KEYS.OUTPUT_FILES,
  missingOutputs: STREAM_DATA_KEYS.MISSING_OUTPUTS,
  compileFailures: STREAM_DATA_KEYS.COMPILE_FAILURES,
  usage: STREAM_DATA_KEYS.USAGE_STATS,
  workPlan: STREAM_DATA_KEYS.WORK_PLAN,
} as const satisfies Record<keyof OverlayPatches, string>;

/**
 * Apply one pending overlay patch, mark its field for the merged write, and
 * clear it. Factors out the check/apply/track/clear shape every
 * {@link OverlayPatches} field replays through in `applyStreamData`; each
 * field's own apply logic stays with its caller.
 */
function consumeOverlay<K extends keyof OverlayPatches>(
  overlays: Partial<OverlayPatches>,
  key: K,
  fieldsToWrite: Set<keyof OverlayPatches>,
  apply: (patch: OverlayPatches[K]) => void,
): void {
  const patch = overlays[key];
  if (patch === undefined) return;
  apply(patch);
  fieldsToWrite.add(key);
  overlays[key] = undefined;
}

/** Later unseeded todos/plan patches win per field. */
function mergeWorkPlanOverlay(
  existing: WorkPlanOverlay | undefined,
  patch: WorkPlanOverlay,
): WorkPlanOverlay {
  return { ...existing, ...patch };
}

/**
 * Merge a per-run usage delta patch into an existing overlay patch,
 * accumulating (not replacing) each run's totals — mirrors the in-memory
 * sum `applyUsageDeltaMemory` performs, so the overlay replayed after
 * seeding matches what was already applied eagerly.
 */
function mergeUsagePatch(
  existing: Map<ExecutionId, TokenUsageStats> | undefined,
  patch: Map<ExecutionId, TokenUsageStats>,
): Map<ExecutionId, TokenUsageStats> {
  const merged = existing ?? new Map<ExecutionId, TokenUsageStats>();
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

function workPlanProvenanceOf(
  baseline: DiskState,
  overlays: Partial<OverlayPatches>,
): WorkPlanProvenance {
  // Without an established baseline the output-file / missing-output /
  // compile-failure / usage overlays are deltas over an unread disk state, so
  // they establish nothing. Plan and todos are replacements, so a live overlay
  // for either is authoritative on its own.
  const complete = baseline !== 'unknown';
  return {
    todos: complete || overlays.workPlan?.todos !== undefined,
    plan: complete || overlays.workPlan?.plan !== undefined,
  };
}

/**
 * Every per-stream field this store tracks, keyed by stream id in ONE map
 * (`records`): the accumulators, the `diskState`/`seedChain` seeding
 * bookkeeping, and the overlay patches. Because every field
 * for a stream lives on the same object, dropping a stream's memory is one
 * `records.delete(stream)` — every field disappears with it BY CONSTRUCTION,
 * so `evict()` cannot drift from the field list. That includes the
 * `generation` token: dropping the record revokes it, and a re-created record
 * mints a fresh one, so a continuation captured against the old record stays
 * detectable without a second map of historical stream ids. `writeMutexes`
 * (keyed by the compound `${stream}::${key}`, not a bare stream id) lives in
 * {@link SidecarWriteCoordinator}.
 */
interface StreamRecord {
  /**
   * Revocable identity of this resident record, captured by asynchronous
   * seed and write work. Rotated by staged deletion and revoked with the
   * record, so work started against an earlier incarnation sees a mismatch.
   */
  generation: symbol;
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
  // data. `diskState` = this record's disk provenance; `seedChain` is the
  // latest unit of work queued on this stream's `seedQueueFor` lane, published
  // for readers that await seed/mutate quiescence (`awaitSeeded`, `flush`,
  // staged deletion) — the lane itself, not this field, serializes the work.
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

export class StreamSnapshotStore {
  private readonly records = new ResidentStreamRegistry<
    StreamTabId,
    StreamRecord
  >(() => ({
    generation: Symbol(),
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
   * What each hydrated stream's last run turned out to be — see
   * {@link RunPhaseFacts}. Kept beside the records rather than in them so it
   * outlives the record: a rail that shows every tab's phase must not pin
   * every tab's accumulators (#9947). An entry is written when a stream
   * hydrates, dropped when its execution changes hands, and dropped with the
   * stream itself; a record released for residency keeps its entry.
   */
  private readonly runFacts = new Map<StreamTabId, RunPhaseFacts>();
  /**
   * The crash-safe staged-deletion + rollback-recovery machine. It owns which
   * namespace holds a staged stream's data and the sidecar writes buffered
   * behind that rename; this store keeps the records and stream generations
   * it reaches back for through {@link StagedDeletionHost} (the write mutexes
   * live in {@link SidecarWriteCoordinator}, reached through the same host).
   */
  private readonly deletions = new StagedDeletionCoordinator({
    queueWrite: (stream, key, value) =>
      this.writes.queueWrite(stream, key, value),
    cancelPendingWrites: (stream) =>
      this.writes.cancelPendingWritesForStream(stream),
    invalidateStreamGeneration: (stream) => this.rotateGeneration(stream),
    seedChain: (stream) => this.records.get(stream)?.seedChain,
    evict: (stream) => this.forget(stream),
  } satisfies StagedDeletionHost);

  /**
   * The write-durability lane: per-(stream, category) serialized write locks,
   * dirty-write tracking, and bounded retries. It reaches back for the KV
   * handle, the staged-deletion write buffer, and the stream-generation guard
   * through {@link SidecarWriteHost}.
   */
  private readonly writes = new SidecarWriteCoordinator({
    kvWrite: (stream, key, value) => this.kv(stream).write(key, value),
    bufferWrite: (stream, key, value) =>
      this.deletions.bufferWrite(stream, key, value),
    captureDirtyWrite: (stream, key, value) =>
      this.deletions.captureDirtyWrite(stream, key, value),
    streamGeneration: (stream) => this.streamGeneration(stream),
    isCurrentGeneration: (stream, generation) =>
      this.isCurrentGeneration(stream, generation),
  } satisfies SidecarWriteHost);

  /**
   * Per-stream FIFO lane (concurrency 1) that serializes seed reads and the
   * mutations queued behind them — the same `PQueue({ concurrency: 1 })`-
   * per-key precedent as `streamApprovalQueue.ts`. Each queued unit of work
   * still publishes its promise onto `record.seedChain` for the readers that
   * await it (`awaitSeeded`, `flush`, staged deletion).
   */
  private readonly seedQueues = new Map<StreamTabId, PQueue>();

  private seedQueueFor(stream: StreamTabId): PQueue {
    return getOrCreatePQueue(this.seedQueues, stream);
  }

  /**
   * Per stream, the accessors already warned about a synchronous read served
   * from a record with unestablished disk provenance, so a render loop
   * re-reading the same stream stays one warning per accessor instead of log
   * spam. Keyed by stream so evict drops the entry outright (a re-seeded
   * stream that is read too early again deserves a fresh warning) rather than
   * scanning every other stream's keys for a `${stream}::` prefix.
   */
  private readonly unseededReadWarned = new Map<StreamTabId, Set<string>>();

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
      // Usage rides the mirror so a stream whose record has been released
      // (`requestEviction`) still answers the roster's token column without
      // re-seeding every finished child.
      ...(record.usage.size > 0 && {
        cumulativeUsage: sumUsageStats(record.usage.values()),
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
    let warned = this.unseededReadWarned.get(stream);
    if (!warned) {
      warned = new Set<string>();
      this.unseededReadWarned.set(stream, warned);
    }
    if (warned.has(accessor)) return;
    warned.add(accessor);
    log.warn(
      `${accessor}(${stream}) served a record with unestablished disk ` +
        `provenance; persisted sidecar state may be missing from the ` +
        `result. Await preload([stream]) first or read the stream summary ` +
        `instead (#9947).`,
    );
  }

  private getOrCreateRecord(stream: StreamTabId): StreamRecord {
    const resident = this.records.get(stream);
    if (resident) return resident;
    const record = this.records.getOrCreate(stream);
    // A record minted for a stream the mirror already knows — a released one
    // that a late fact touches — starts from what the mirror holds, so
    // publishing that one field republishes a whole summary that keeps the
    // rest. Record fields still win: the fallback only fills gaps.
    record.summaryMetaHydrationFallback = this.summaryMetaSource?.(stream);
    return record;
  }

  private kv(streamId: StreamTabId): KVStore {
    // A handle holds only the storage-root-relative directory and every
    // operation re-resolves the root, so constructing one per access is
    // equivalent to caching it and never goes stale.
    return new KVStore(streamDataDir(streamId));
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

  private streamGeneration(stream: StreamTabId): symbol {
    return this.getOrCreateRecord(stream).generation;
  }

  private isCurrentGeneration(
    stream: StreamTabId,
    generation: symbol,
  ): boolean {
    return this.records.get(stream)?.generation === generation;
  }

  /** Revoke every continuation captured against the current record. */
  private rotateGeneration(stream: StreamTabId): void {
    const record = this.records.get(stream);
    if (record) record.generation = Symbol();
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
    const detachRunEvents = events.subscribeRunFacts(
      ({ event }) => {
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
            this.applyRoundFieldFact(
              event.streamId,
              'outputFiles',
              event.filesByRound,
            );
            return;
          case 'updateMissingOutputs':
            this.applyRoundFieldFact(
              event.streamId,
              'missingOutputs',
              event.filesByRound,
            );
            return;
          case 'updateCompileFailures':
            this.applyRoundFieldFact(
              event.streamId,
              'compileFailures',
              event.filesByRound,
            );
            return;
          default: {
            // Exhaustiveness check: adding a type to `SNAPSHOT_RUN_FACT_TYPES`
            // without handling it here is a compile error, not a silent drop.
            const unhandled: never = event;
            return unhandled;
          }
        }
      },
      { types: SNAPSHOT_RUN_FACT_TYPES },
    );
    const detachSessionEvents = events.subscribeSessionFacts((fact) => {
      switch (fact.type) {
        case 'updateStreamDescription':
          this.setDescription(fact.payload.streamId, fact.payload.description);
          return;
        case 'setParentStream':
          this.setParentStream(
            fact.payload.childStreamId,
            fact.payload.parentStreamId,
          );
          return;
        default:
          return;
      }
    });

    return () => {
      detachSessionEvents();
      detachRunEvents();
    };
  }

  /**
   * Queue a mutation onto the stream's seed lane: the lane's single-flight
   * FIFO order (concurrency 1, shared with `refreshSeed`) is what guarantees
   * this runs after every unit of work queued ahead of it, seed reads
   * included — the read itself must run INSIDE a queued task, not before
   * enqueueing, or a `refreshSeed` racing on the same stream could start its
   * own disk read concurrently with this one (the queue only serializes what
   * it dispatches; anything started outside `add()` runs unguarded). Each
   * task re-checks `hasDiskProvenance` before reading, so once the first
   * queued task establishes it, every task queued behind it skips straight
   * to `apply`.
   */
  private queueAfterSeed(
    stream: StreamTabId,
    generation: symbol,
    apply: () => unknown,
  ): Promise<void> {
    const next: Promise<void> = this.seedQueueFor(stream)
      .add(async () => {
        if (!this.hasDiskProvenance(stream)) {
          try {
            await this.readSeed(stream, generation);
          } catch (err: unknown) {
            if (!this.hasDiskProvenance(stream)) throw err;
          }
        }
        if (!this.isCurrentGeneration(stream, generation)) return;
        const record = this.records.get(stream);
        if (!record || record.diskState === 'unknown') return;
        apply();
      })
      .catch((err: unknown) => {
        log.warn(`Deferred update failed for stream ${stream}`, {
          data: err,
        });
      }) as Promise<void>;
    this.getOrCreateRecord(stream).seedChain = next;
    return next;
  }

  private async readSeed(
    stream: StreamTabId,
    generation: symbol,
  ): Promise<void> {
    if (!this.isCurrentGeneration(stream, generation)) return;
    if (this.hasDiskProvenance(stream)) return;
    await this.writes.retryDirtyWrites(stream);
    if (!this.isCurrentGeneration(stream, generation)) return;
    await this.seedFromDisk(stream, generation);
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
    generation: symbol,
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
    if (!this.isCurrentGeneration(stream, generation)) return;
    const data = exists
      ? await readStreamData(this.kv(stream))
      : emptyStreamData();
    if (!this.isCurrentGeneration(stream, generation)) return;
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

  // Shallow copy: each write is queued, so the record is snapshotted at call
  // time rather than letting later round mutations leak into a pending write.
  // The sidecar key is derived from OVERLAY_TO_SIDECAR_KEY rather than taken
  // as a separate param, so a caller can't pass a field/key pair that disagree.
  private writeRoundKeyedField(
    stream: StreamTabId,
    field: RoundKeyedField,
  ): void {
    this.writes.write(stream, OVERLAY_TO_SIDECAR_KEY[field], {
      ...this.records.get(stream)?.[field],
    });
  }

  private applyUsageDeltaMemory(
    record: StreamRecord,
    storageKey: ExecutionId,
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
    this.writes.write(stream, STREAM_DATA_KEYS.USAGE_STATS, payload);
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
  private mutateWithOverlay<K extends keyof OverlayPatches>(
    stream: StreamTabId,
    overlayKey: K,
    overlayPatch: OverlayPatches[K] | undefined,
    mergePatch: (
      existing: OverlayPatches[K] | undefined,
      patch: OverlayPatches[K],
    ) => OverlayPatches[K],
    applyToMemory: () => void,
    persist: () => void,
  ): void {
    applyToMemory();

    if (this.hasDiskProvenance(stream)) {
      persist();
      return;
    }

    const generation = this.streamGeneration(stream);
    if (overlayPatch !== undefined) {
      const { overlays } = this.getOrCreateRecord(stream);
      overlays[overlayKey] = mergePatch(overlays[overlayKey], overlayPatch);
    }
    this.queueAfterSeed(stream, generation, () => undefined);
  }

  /**
   * Apply one round-keyed run fact (`addOutputFiles` / `updateMissingOutputs`
   * / `updateCompileFailures`) to its field: parse the wire patch per round
   * through the field's normalizer (see {@link ROUND_FIELD_NORMALIZERS} for
   * the delete-vs-overwrite semantics), skip effectively-empty patches, and
   * run the shared eager-apply + overlay-reconcile sequence.
   */
  private applyRoundFieldFact<K extends RoundKeyedField>(
    stream: StreamTabId,
    field: K,
    filesByRound: RoundIndexed<RoundFieldElement[K]>,
  ): void {
    const normalize = ROUND_FIELD_NORMALIZERS[field];
    const patch = new Map<number, RoundFieldElement[K][] | null>();
    for (const [round, raw] of Object.entries(filesByRound)) {
      const key = RoundKeySchema.safeParse(round);
      if (!key.success) continue;
      patch.set(key.data, normalize(raw));
    }
    if (patch.size === 0) return;

    // The two casts restate what the tables above pin per key — `patch`
    // holds exactly the element type `OverlayPatches[K]` stores, and
    // `mergeRoundPatch` services every round-keyed overlay — but TS cannot
    // reduce the `OverlayPatches[K]` indexed access while `K` is generic.
    this.mutateWithOverlay(
      stream,
      field,
      patch as OverlayPatches[K],
      mergeRoundPatch as (
        existing: OverlayPatches[K] | undefined,
        next: OverlayPatches[K],
      ) => OverlayPatches[K],
      () =>
        this.applyRoundPatch(
          ROUND_FIELD_OF[field],
          this.getOrCreateRecord(stream),
          patch,
        ),
      () => this.writeRoundKeyedField(stream, field),
    );
  }

  /**
   * Accumulate usage per run.
   */
  private addUsage(
    stream: StreamTabId,
    storageKey: ExecutionId,
    usage: ExtendedTokenUsageStats,
  ): void {
    // UI-only per-round display fields are not part of the durable usage row.
    // Remove them at this live-event boundary so the strict persisted schema
    // continues to reject unknown fields from disk.
    const {
      elapsedTime: _elapsedTime,
      percentageCached: _percentageCached,
      toolUseTokens: _toolUseTokens,
      ...persistedUsage
    } = usage;
    const parsed = TokenUsageStatsParsingBaseSchema.safeParse(persistedUsage);
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
    const overlayPatch = isEmptyUsage(delta)
      ? undefined
      : new Map<ExecutionId, TokenUsageStats>([[storageKey, delta]]);

    this.mutateWithOverlay(
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
        this.publishSummaryMeta(stream);
      },
    );
  }

  // ==========================================================================
  // Read accessors over in-memory accumulated state
  // ==========================================================================

  // These four hand back the live record as a readonly view rather than a
  // defensive copy. Every reader enumerates, filters, or forwards the result;
  // none mutates it, so the copy bought nothing at runtime while allocating a
  // fresh object and a fresh array per round on every call — on each render
  // pass, in every host.
  //
  // The rule this puts on callers: a synchronous read is safe, because renders
  // compose in one tick and the CLI's projection memo is cleared on every
  // artifact write. **A caller that carries the result across an `await` must
  // clone it** — `applyRoundPatch` mutates these records in place, so a live
  // run can add or drop a round while the caller is suspended. See
  // `ProgressWorkflowRunActionsController.diffStream`, which snapshots before the
  // request crosses an interactive quick pick.
  //
  // The write path still snapshots (`snapshotFromMemory`, `writeRoundKeyedField`),
  // where the isolation is load-bearing: writes are queued, so the record must
  // be frozen at call time.
  getOutputFiles(stream: StreamTabId): ReadonlyRoundIndexed<OutputFileInfo> {
    this.warnIfUnseeded('getOutputFiles', stream);
    return this.records.get(stream)?.outputFiles ?? EMPTY_ROUND_INDEXED;
  }

  getMissingOutputs(stream: StreamTabId): ReadonlyRoundIndexed<string> {
    this.warnIfUnseeded('getMissingOutputs', stream);
    return this.records.get(stream)?.missingOutputs ?? EMPTY_ROUND_INDEXED;
  }

  getCompileFailures(
    stream: StreamTabId,
  ): ReadonlyRoundIndexed<CompileFailure> {
    this.warnIfUnseeded('getCompileFailures', stream);
    return this.records.get(stream)?.compileFailures ?? EMPTY_ROUND_INDEXED;
  }

  getRunUsage(stream: StreamTabId): ReadonlyMap<string, TokenUsageStats> {
    this.warnIfUnseeded('getRunUsage', stream);
    return this.records.get(stream)?.usage ?? EMPTY_RUN_USAGE;
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

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Release a stream's resident record once its in-flight seed and sidecar
   * writes have settled: the sidecar counterpart of the transcript's
   * terminal-status eviction (`StreamLogStore.requestEviction`). The next
   * read re-seeds from disk through `preload`, which every presentation path
   * performs before its synchronous reads, so nothing is lost. A record a
   * staged deletion owns, one a reader is seeding, or one that gains new seed
   * work while this waits stays resident: someone else is about to read or
   * remove it.
   *
   * `shouldStillEvict` is re-read after those awaits, the same shape
   * `StagedDeletionCoordinator.commit` uses: a run that relaunches this
   * stream while the drain is in flight neither rotates the generation nor
   * rebinds the seed chain once provenance is established, so the caller's
   * own liveness rule is what keeps a freshly active record resident.
   *
   * Public on purpose, and the one row added to the store-surface baseline:
   * the session's lifecycle owner requests it for a child stream nobody is
   * presenting and no live run in this process owns, and a host's focus-leave
   * path requests it for the stream it just stopped presenting. Without it,
   * the record set grows with every stream a long session touches.
   */
  async requestEviction(
    stream: StreamTabId,
    shouldStillEvict?: () => boolean,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_EVICTION_DRAIN_ATTEMPTS; attempt++) {
      const record = this.records.get(stream);
      if (!record || this.deletions.owns(stream)) return;
      const { generation, seedChain } = record;
      // A reader-driven seed is a caller that asked for this record and will
      // read it synchronously when its `preload` resolves. Releasing it out
      // from under that caller would answer its question with an empty
      // record, so the next release trigger collects it instead. `refreshSeed`
      // parks the pre-refresh disk state for exactly its own duration, so that
      // — not the seed queue, which fact-driven mutations share, and whose
      // work no reader is waiting on — is what names a reader.
      if (record.seedRefreshBaseline !== undefined) return;
      // `seedChain` is the newest queued task either path published, so
      // awaiting it drains the queue as it stood; anything queued behind it
      // rebinds the field and the identity check below sees that instead.
      await seedChain;
      await this.writes.retryDirtyWrites(stream);
      const current = this.records.get(stream);
      if (
        !current ||
        current.generation !== generation ||
        current.seedChain !== seedChain ||
        this.deletions.owns(stream) ||
        shouldStillEvict?.() === false
      ) {
        return;
      }
      // A mutation that landed on an already-seeded record during the drain
      // persists directly, without rebinding `seedChain`, so neither check
      // above sees it. Evicting would drop its write lock together with the
      // record and strand the value in neither memory nor disk, so re-drain
      // instead — and read this with no await between it and the eviction.
      if (this.writes.hasDirtyWrites(stream)) continue;
      this.evict(stream);
      return;
    }
  }

  /**
   * Release a stream's resident record. The stream itself lives on, so its
   * {@link RunPhaseFacts} stay: releasing the accumulators is what bounded
   * residency buys, and dropping the four fields with them would make every
   * released tab's phase read as unknown again. Disk cleanup is the caller's
   * job.
   */
  private evict(stream: StreamTabId): void {
    this.records.delete(stream);
    this.seedQueues.delete(stream);
    this.writes.dropStreamWrites(stream);
    this.unseededReadWarned.delete(stream);
  }

  /**
   * Drop everything this store holds for a stream that is gone — a committed
   * deletion, or a stream the authoritative roster no longer lists. The one
   * eviction that also forgets the run facts.
   */
  private forget(stream: StreamTabId): void {
    this.evict(stream);
    this.runFacts.delete(stream);
  }

  /**
   * Reconcile crash-interrupted deletions against the transcript registry.
   * A live transcript rolls its snapshot directory back. An absent transcript
   * restores the directory only into the orphan-cleanup namespace so the
   * execution directory and goal can be removed with the snapshot.
   */
  async reconcileStagedDeletions(
    liveStreams: ReadonlySet<StreamTabId>,
    selectedStreams?: ReadonlySet<StreamTabId>,
  ): Promise<{
    restored: StreamTabId[];
    pendingCleanup: StreamTabId[];
    discarded: StreamTabId[];
  }> {
    return this.deletions.reconcile(liveStreams, selectedStreams);
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
      commit: async (shouldDelete?: () => boolean): Promise<boolean> => {
        // A late supersede means the fresh incarnation re-claimed the stream
        // while the staged copy was being deleted; its buffered sidecars were
        // replayed back into the live namespace, so the stream still lives and
        // the child-detachment/projection/flush below must not run.
        if (await deletion.commit(shouldDelete)) return true;
        // Re-check before the awaited detachment/flush below: a re-claim
        // landing right after the staged copy was removed must not detach the
        // fresh incarnation's children or flush against its live namespace.
        if (shouldDelete && !shouldDelete()) return true;
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
        return false;
      },
      rollback: () => deletion.rollback(),
    };
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
    this.writes.write(stream, STREAM_DATA_KEYS.META, file);
  }

  private queueMetaPatch(
    stream: StreamTabId,
    patch: Partial<StreamTabMeta>,
  ): void {
    this.patchMetaMemory(stream, patch);
    this.getOrCreateRecord(stream).metaOverlay = true;
    const applyMeta = (): void => {
      this.writeMeta(stream, this.patchMetaMemory(stream, patch));
    };
    // Persist immediately once the stream's disk provenance is established;
    // otherwise queue behind the per-stream seed chain so it merges onto the
    // real sidecar state instead of an empty base, leaving `metaOverlay` set
    // for `applyStreamData`/`persistEagerOverlays` to reconcile.
    if (this.hasDiskProvenance(stream)) {
      applyMeta();
      this.getOrCreateRecord(stream).metaOverlay = false;
    } else {
      this.queueAfterSeed(stream, this.streamGeneration(stream), applyMeta);
    }
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
    // The same evidence `setRunStart` uses: a record minted after a bounded-
    // residency release knows the execution it succeeds only through the
    // mirror it started from, and reading the record field alone would let
    // the departed run's identity, description, and run facts — which outlive
    // the record by design — be read as this run's.
    const previous =
      record.runExecutionId ?? record.summaryMetaHydrationFallback?.executionId;
    if (executionId && previous && previous !== executionId) {
      // A config for a new execution the store never saw `run.start` for:
      // the previous run's identity and description are not this run's.
      // Identity stays absent (renders pending) until `run.start` or a seed
      // reads the durable `ExecutionMeta.identity` — never synthesized here.
      record.runIdentity = undefined;
      record.userFollowUpSupport = undefined;
      record.description = undefined;
      this.runFacts.delete(stream);
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
    // KNOWN previous execution drops it. A record minted after a release
    // knows the previous execution only through the mirror it started from,
    // so that names the handoff when the record itself cannot.
    const previous =
      record.runExecutionId ?? record.summaryMetaHydrationFallback?.executionId;
    if (previous && previous !== executionId) {
      record.runConfig = undefined;
      record.description = undefined;
      this.runFacts.delete(stream);
      // Only what the departing execution owned: the stream's parent edge and
      // its summed usage outlive any single run, and on a record minted after
      // a release the fallback is their only source until seeding lands.
      record.summaryMetaHydrationFallback = withoutSummaryMetaFields(
        record.summaryMetaHydrationFallback,
        EXECUTION_SCOPED_SUMMARY_META_FIELDS,
      );
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
  getRunMetadata(
    stream: StreamTabId,
    options?: { readonly quiet?: boolean },
  ): RunMetadata {
    if (!options?.quiet) {
      this.warnIfUnseeded('getRunMetadata', stream);
    }
    const record = this.records.get(stream);
    return Object.freeze({
      executionId: record?.runExecutionId,
      identity: record?.runIdentity,
      userFollowUpSupport: record?.userFollowUpSupport,
      config: record?.runConfig,
      description: record?.description,
    });
  }

  /**
   * What this stream's last run turned out to be, or `undefined` for a stream
   * that has never hydrated — see {@link RunPhaseFacts}.
   *
   * Deliberately not part of {@link getRunMetadata}: those five fields are the
   * record's, and go with it. These four are the store's, and survive a
   * record released for residency, which is the only reason a caller can ask
   * every tab's phase without making every tab resident. Never warns about an
   * unseeded read — "not hydrated yet" is one of the answers.
   */
  getRunPhaseFacts(stream: StreamTabId): RunPhaseFacts | undefined {
    return this.runFacts.get(stream);
  }

  /**
   * Whether this stream's accumulators answer from memory rather than from
   * unread defaults: its disk provenance is established, or a live fact has
   * already been eagerly applied ahead of any seed (the overlay this store
   * replays after seeding). That is the disk-provenance condition
   * {@link warnIfUnseeded} checks plus any live overlay, so it is the weaker
   * of the two: an overlay-only record answers here but still emits
   * unseeded-read warnings for the fields it holds no overlay for. Published
   * so a caller can gate its reads on this bookkeeping instead of shadowing
   * it with a hydration set of its own. A usage-only seed does not count: it
   * leaves every round artifact unread.
   */
  hasProvenance(stream: StreamTabId): boolean {
    const record = this.records.get(stream);
    if (!record) return false;
    if (record.diskState !== 'unknown') return true;
    return Object.values(record.overlays).some((patch) => patch !== undefined);
  }

  /**
   * Which work-plan fields this record can vouch for right now — the same
   * question {@link StreamSnapshotPreloadError.workPlanProvenance} answers at
   * one failure instant, asked live. A reader that could not vouch for a field
   * when its load failed re-reads this instead of tracking promotions of its
   * own: a later live todos/plan write or a completed seed establishes the
   * field here, and this store is the only owner of that fact.
   *
   * An in-flight refresh does not retract it. `refreshSeed` parks the record at
   * 'unknown' so mutations queue behind the new read, but the accumulators it
   * is about to refresh still hold their established values, so the captured
   * `seedRefreshBaseline` — not the parked state — answers for readers.
   */
  workPlanProvenance(stream: StreamTabId): WorkPlanProvenance {
    const record = this.records.get(stream);
    if (!record) return { plan: false, todos: false };
    return workPlanProvenanceOf(
      record.seedRefreshBaseline ?? record.diskState,
      record.overlays,
    );
  }

  /** Streams with persisted sidecars under `streamData/`. */
  async listPersistedStreams(): Promise<StreamTabId[]> {
    return this.listStreamsUnder(STREAM_DATA_DIR);
  }

  /** Streams left in reversible staging by an interrupted deletion. */
  async listStagedDeletions(): Promise<StreamTabId[]> {
    return this.listStreamsUnder(STREAM_DATA_DELETION_DIR);
  }

  getParentStreamId(stream: StreamTabId): StreamTabId | undefined {
    this.warnIfUnseeded('getParentStreamId', stream);
    return this.records.get(stream)?.meta?.parentStreamId;
  }

  /**
   * Find children of `parent`, clear their durable parent edges, and seed
   * them so a follow-up `onCommitted` projection (session registry / UI
   * facts) can run against resident records. Edge clearing stays here so
   * callers with no session — history delete, CLI cleanup — still detach
   * without widening this store's public surface.
   */
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
    const attached = children.filter(
      (child) => this.getParentStreamId(child) === parent,
    );
    for (const child of attached) {
      // A live session later echoes this edge removal through its UI fact
      // projection. That round-trip is redundant for this store, but the
      // direct write is required for history/CLI callers with no session.
      this.setParentStream(child, null);
    }
    return attached;
  }

  /** Read-only view of stream→executionId for waiting-stream detection. */
  getExecutionIdMap(): ReadonlyMap<StreamTabId, ExecutionId> {
    const map = new Map<StreamTabId, ExecutionId>();
    for (const [stream, record] of this.records) {
      // Per-record loudness: a resident record without established disk
      // provenance may be missing its persisted executionId here. Streams
      // with no record at all are outside this accessor's contract (callers
      // merge `readExecutionStreamIndex` for those), so only
      // resident-but-unknown records warrant a warning.
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
    this.writes.write(
      stream,
      STREAM_DATA_KEYS.WORK_PLAN,
      PersistedWorkPlanSchema.parse({
        schemaVersion: STREAM_SNAPSHOT_SCHEMA_VERSION,
        todos: plan.todos,
        plan: plan.plan,
        planSummary: plan.planSummary,
      }),
    );
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
        await this.writes.retryDirtyWrites();
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
   * Only an unseeded stream — a display-only read from a call-scoped store that
   * was never `load`ed or `preload`ed — hits disk.
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
   * Clones the round-indexed records — unlike the public getOutputFiles/
   * getMissingOutputs/getCompileFailures accessors, which return live readonly
   * views — so a caller reassigning
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
   *
   * `reportArtifactAuthority` wraps a failed full preload with the fields whose
   * prior seed or live overlay remains authoritative, so a reader may retain
   * accepted in-memory state without treating unread disk defaults as facts.
   */
  async preload(
    streamIds: readonly StreamTabId[],
    options?: {
      readonly reportArtifactAuthority?: boolean;
    },
  ): Promise<void> {
    await this.seedStreams(streamIds, options?.reportArtifactAuthority);
  }

  private async seedStreams(
    streamIds: readonly StreamTabId[],
    reportArtifactAuthority = false,
  ): Promise<void> {
    await pMap(
      streamIds,
      (streamId) => this.refreshSeed(streamId, reportArtifactAuthority),
      { concurrency: SEED_IO_CONCURRENCY },
    );
  }

  private evictStreamsExcept(keep: ReadonlySet<StreamTabId>): void {
    // `load` is authoritative about the stream set, so a stream missing from
    // it is gone rather than merely released: forget its run facts too.
    for (const stream of new Set([
      ...this.records.keys(),
      ...this.runFacts.keys(),
    ])) {
      if (!keep.has(stream)) this.forget(stream);
    }
  }

  private refreshSeed(
    stream: StreamTabId,
    reportArtifactAuthority = false,
  ): Promise<void> {
    const generation = this.streamGeneration(stream);
    const record = this.getOrCreateRecord(stream);
    const refreshBaseline = record.seedRefreshBaseline ?? record.diskState;
    record.seedRefreshBaseline = refreshBaseline;
    const refreshGeneration = ++record.seedRefreshGeneration;
    record.diskState = 'unknown';
    const next: Promise<void> = this.seedQueueFor(stream)
      .add(async () => {
        if (!this.isCurrentGeneration(stream, generation)) return;
        await this.writes.retryDirtyWrites(stream);
        if (!this.isCurrentGeneration(stream, generation)) return;
        await this.seedFromDisk(stream, generation);
      })
      .then(
        () => {
          const current = this.records.get(stream);
          if (
            current?.seedRefreshGeneration === refreshGeneration &&
            this.isCurrentGeneration(stream, generation)
          ) {
            current.seedRefreshBaseline = undefined;
          }
        },
        (error: unknown) => {
          const current = this.records.get(stream);
          const generationIsCurrent = this.isCurrentGeneration(
            stream,
            generation,
          );
          // Snapshot the surviving state BEFORE the restore below, whose
          // `persistEagerOverlays` drains the very overlays it reads.
          const resolvedRefreshBaseline =
            refreshBaseline === 'unknown'
              ? current?.diskState
              : refreshBaseline;
          const failureBaseline: DiskState | undefined =
            reportArtifactAuthority && current && generationIsCurrent
              ? resolvedRefreshBaseline
              : undefined;
          const failureWorkPlanProvenance =
            failureBaseline !== undefined && current
              ? workPlanProvenanceOf(failureBaseline, current.overlays)
              : undefined;
          if (
            current?.seedRefreshGeneration === refreshGeneration &&
            generationIsCurrent
          ) {
            current.diskState = refreshBaseline;
            current.seedRefreshBaseline = undefined;
            if (refreshBaseline !== 'unknown') {
              this.persistEagerOverlays(stream, current);
            }
            if (current.seedChain === next) current.seedChain = undefined;
          }
          if (failureBaseline !== undefined && failureWorkPlanProvenance) {
            throw new StreamSnapshotPreloadError(
              error,
              stream,
              failureBaseline !== 'unknown',
              failureWorkPlanProvenance,
            );
          }
          throw error;
        },
      ) as Promise<void>;
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
    let authorityFailure: string | undefined;
    let outcome: RunOutcome | undefined;

    if (executionId) {
      let config: AgentConfig | null = null;
      try {
        const store = getExecutionStore(executionId);
        // Strict: a malformed row is an unreadable authority, not a run that
        // never finished. The tolerant reader resolves to null, which would
        // derive as "no outcome" and render a corrupt execution as a healthy,
        // sendable stream — the same distinction `listExecutionStreamReferences`
        // draws for restart repair today.
        const [execMeta, execConfig] = await Promise.all([
          store.readMetaStrict(),
          store.readConfig(),
        ]);
        // Identity comes only from the stamped execution row; a row without
        // one hydrates without an identity — never reconstruct one from
        // stream-id prefixes or config.
        identity = execMeta?.identity;
        userFollowUpSupport = execMeta?.userFollowUpSupport;
        description = execMeta?.description;
        // The run's terminal outcome rides the same parsed row, at no cost.
        outcome = execMeta?.outcome;
        config = execConfig;
      } catch (error) {
        authorityFailure = toErrorMessage(error);
        log.warn(`Could not read execution record for stream ${stream}.`, {
          data: { stream, executionId, error },
        });
      }
      if (config) {
        return {
          authorityFailure,
          config,
          identity,
          userFollowUpSupport,
          description,
          outcome,
        };
      }
    }

    // Same facts on the no-config path: a stream whose `config.json` is
    // missing still has a readable identity and outcome.
    return {
      authorityFailure,
      identity,
      userFollowUpSupport,
      description,
      outcome,
    };
  }

  /**
   * Whether a resumable checkpoint file exists, and who holds the execution
   * lease. Both are one read: the checkpoint is a single `exists` stat, never
   * a parse of the (often ~600 KB) flow record, and the lease inspection reads
   * only — a dead claim reports as absent and is unlinked by the next claim,
   * never by this call. Never throws: an unreadable probe reports its cause,
   * which the phase rule renders as unavailable rather than as a run that
   * never happened.
   */
  private async probeRunPhase(
    executionId: ExecutionId,
  ): Promise<RunPhaseProbe> {
    try {
      const [checkpointPresent, lease] = await Promise.all([
        getExecutionStore(executionId).exists(flowKey(executionId)),
        inspectExecutionLease(executionId),
      ]);
      return { checkpointPresent, lease };
    } catch (error) {
      log.warn(`Could not read run phase facts for execution ${executionId}.`, {
        data: { executionId, error },
      });
      return { failure: toErrorMessage(error) };
    }
  }

  /** Seed the in-memory accumulators for one stream. */
  private async applyStreamData(
    stream: StreamTabId,
    data: StreamData,
    provenance: Exclude<DiskState, 'unknown'>,
  ): Promise<void> {
    const generation = this.streamGeneration(stream);
    const record = this.getOrCreateRecord(stream);
    const metaOverlay = record.metaOverlay ? record.meta : undefined;
    const usageOverlayToReplay = new Map(record.overlays.usage);
    const fieldsToWrite = new Set<keyof OverlayPatches>();

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
      this.runFacts.delete(stream);
      record.summaryMetaHydrationFallback = undefined;
    }
    // Started before the metadata await so both reads overlap, and awaited at
    // the very end so a display-only fact never delays the record's restore.
    const phaseProbe = executionId
      ? this.probeRunPhase(executionId)
      : undefined;
    // Accumulated locally and published once at the end: the map is what
    // readers see, and half a tuple would render a stopped run as a healthy
    // one for the length of the probe.
    let runFacts: RunPhaseFacts = {};
    if (meta) {
      const pendingLiveWrite = metaOverlay !== undefined;
      const configBeforeHydration = record.runConfig;
      const hydrated = await this.hydrateRunStateFromMeta(stream, meta);
      const mirroredMeta = this.summaryMetaSource?.(stream);
      const mirroredExecutionId =
        mirroredMeta?.executionId ?? previousExecutionId;
      if (
        hydrated.authorityFailure !== undefined &&
        mirroredExecutionId === executionId
      ) {
        record.summaryMetaHydrationFallback = withoutSummaryMetaFields(
          mirroredMeta,
          ['executionId', 'parentStreamId'],
        );
      } else {
        record.summaryMetaHydrationFallback = undefined;
      }
      if (!this.isCurrentGeneration(stream, generation)) return;
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
        // Whole-value: this read is the only producer of the run's outcome,
        // so it replaces rather than fills, and a failed read says so with
        // the cause attached instead of leaving a quiet absence.
        runFacts = {
          ...(hydrated.outcome !== undefined && { outcome: hydrated.outcome }),
          ...(hydrated.authorityFailure !== undefined && {
            authorityFailure: hydrated.authorityFailure,
          }),
        };
      }
    }

    const { overlays } = record;
    consumeOverlay(overlays, 'outputFiles', fieldsToWrite, (patch) =>
      this.applyRoundPatch((r) => r.outputFiles, record, patch),
    );
    consumeOverlay(overlays, 'missingOutputs', fieldsToWrite, (patch) =>
      this.applyRoundPatch((r) => r.missingOutputs, record, patch),
    );
    consumeOverlay(overlays, 'compileFailures', fieldsToWrite, (patch) =>
      this.applyRoundPatch((r) => r.compileFailures, record, patch),
    );
    // Pre-await snapshot, not `patch`: deltas that landed during the hydration
    // await were already applied to the refreshed record.usage, so replaying
    // the merged overlay would count them twice.
    consumeOverlay(overlays, 'usage', fieldsToWrite, () => {
      for (const [storageKey, delta] of usageOverlayToReplay) {
        this.applyUsageDeltaMemory(record, storageKey, delta);
      }
    });
    consumeOverlay(overlays, 'workPlan', fieldsToWrite, (overlay) => {
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
    });
    record.diskState = provenance;
    this.writeMergedSidecars(stream, record, fieldsToWrite);
    // Hydration republishes the metadata mirror: the deep-equal gate makes an
    // unchanged projection free, and this lazily backfills old summaries
    // (#9947). After an incomplete read, the fallback preserves fields owned
    // by the same execution while current sidecar fields still refresh; after
    // a handoff, only facts belonging to the new execution are published.
    if (this.records.get(stream) === record) {
      this.publishSummaryMeta(stream);
    }

    if (phaseProbe) {
      const probe = await phaseProbe;
      runFacts = {
        ...runFacts,
        ...(probe.checkpointPresent !== undefined && {
          checkpointPresent: probe.checkpointPresent,
        }),
        ...(probe.lease !== undefined && { lease: probe.lease }),
        ...(runFacts.authorityFailure === undefined &&
          probe.failure !== undefined && { authorityFailure: probe.failure }),
      };
    }
    // Published even when it is empty: the entry's existence is what says this
    // stream hydrated, and it is the only such marker that outlives the
    // record. A deletion (which rotates the generation) or a handoff to
    // another execution during the awaits above makes this tuple somebody
    // else's, so neither publishes.
    if (
      this.isCurrentGeneration(stream, generation) &&
      record.runExecutionId === executionId
    ) {
      this.runFacts.set(stream, Object.freeze(runFacts));
    }
  }

  /** Persist sidecars from merged memory after seeding and overlays converge. */
  private writeMergedSidecars(
    stream: StreamTabId,
    record: StreamRecord,
    fields: Iterable<keyof OverlayPatches>,
  ): void {
    // `record` rode across `applyStreamData`'s hydration await. Identity —
    // not mere presence — against the live map entry: eviction during the
    // await orphans `record`, and a concurrent eager mutation can already have
    // re-created a fresh entry, so a presence check would still let orphaned
    // seed state resurrect the deleted `streamData/{id}/` dir on disk (#8226).
    if (this.records.get(stream) !== record) return;
    for (const field of fields) {
      switch (field) {
        case 'outputFiles':
        case 'missingOutputs':
        case 'compileFailures':
          this.writeRoundKeyedField(stream, field);
          break;
        case 'usage':
          this.writeUsage(stream);
          break;
        case 'workPlan':
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

    const fields = new Set<keyof OverlayPatches>();
    const { overlays } = record;
    for (const field of Object.keys(
      OVERLAY_TO_SIDECAR_KEY,
    ) as (keyof OverlayPatches)[]) {
      if (!overlays[field]) continue;
      fields.add(field);
      overlays[field] = undefined;
    }
    this.writeMergedSidecars(stream, record, fields);
  }
}
