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
 * It consolidates the accumulation logic previously split across the extension's
 * `OutputFilesManager` / `UsageStatsManager` / `StreamMetaManager`, talking to
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
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { TaskStateSchema, type TaskState } from '@agent/core/state/TaskState';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import type { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { isFileNotFoundError } from '@common/errors';
import { KVStore } from '@common/storage/KVStore';
import * as logger from '@logger/logUtils';
import {
  CompileFailureSchema,
  cloneRoundIndexed,
  emptyUsageStats,
  isEmptyUsage,
  OutputFileInfoListSchema,
  PersistedWorkPlanSchema,
  RUN_DESCRIPTOR_SCHEMA_VERSION,
  planSummaryLine,
  RoundKeySchema,
  StreamTabIdSchema,
  sumUsageStats,
  TokenUsageStatsParsingSchema,
  buildRunDescriptor,
  type CompileFailure,
  type ExecutionId,
  type LegacyInstructionEntry,
  type OutputFileInfo,
  type RunDescriptor,
  type Plan,
  type RoundIndexed,
  type StorageKey,
  type StreamSnapshot,
  type StreamTabId,
  type StreamTabMeta,
  type TodoItem,
  type TokenUsageStats,
  type WorkPlanSnapshot,
} from '@shared/schemas';
import { getCleanAgentName } from '@shared/schemas/agent';

import { mapToRecord, normalizeFilePath } from '@utils/core';
import { StorageFS } from '@utils/files';
import { isDirectory } from '@utils/files/fsEntryType';
import {
  canUseStreamDataDir,
  decodeStreamId,
  STREAM_DATA_DELETION_DIR,
  STREAM_DATA_DIR,
  STREAM_DATA_KEYS,
  stagedStreamDataDir,
  streamDataDir,
} from './streamDataPaths';
import {
  assembleSnapshot,
  EMPTY_WORK_PLAN,
  readLegacyInstruction as readLegacyInstructionFromDisk,
  readMeta,
  readStreamData,
  type StreamData,
} from './streamSnapshotRead';

const CHANNEL = 'StreamSnapshotStore';

/** Bounded fan-out for seeding many streams' sidecars (mirrors the retired
 *  managers' `pMap` hydration so startup doesn't open a file handle per tab). */
const SEED_IO_CONCURRENCY = 8;

async function storagePathExists(target: string): Promise<boolean> {
  try {
    await StorageFS.stat(target);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw error;
  }
}

interface StagedStreamSnapshotDeletion {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

const UsageRunEventDataSchema = z.looseObject({
  streamId: StreamTabIdSchema,
  storageKey: z.string().min(1),
  usage: TokenUsageStatsParsingSchema,
});

type OutputFilesPatch = Map<number, OutputFileInfo[] | null>;
type UsageUpdateResult =
  TokenUsageStats | undefined | Promise<TokenUsageStats | undefined>;
interface HydratedRunState {
  config?: AgentConfig;
  descriptor?: RunDescriptor;
}

/**
 * Match criteria for {@link StreamSnapshotStore.findWorkflowStreamsMatching}.
 * Mirrors the `streamConfig` payload on the `clearMissingOutputs` progress
 * event.
 */
interface WorkflowStreamMatch {
  agent: string;
  model: string;
  inputFile: string;
  outputFiles?: readonly string[];
}

function normalizeOutputFiles(outputFiles?: readonly string[]): string[] {
  return (outputFiles ?? [])
    .map((file) => normalizeFilePath(file))
    .filter((file) => file.length > 0)
    .sort();
}

function sameOutputFiles(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((file, index) => file === right[index]);
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

/**
 * Merge {@link RoundOverlay} patches in call order so `clearMissingOutputs`
 * interleaved with `updateMissingOutputs` on the same unseeded stream
 * replays correctly regardless of which fired first: a reset (`clear`)
 * supersedes everything recorded before it — it drops the earlier round
 * patch outright, matching a disk write of `{}` — while a later update
 * layers its round patch on top and preserves whichever reset flag is
 * already recorded. Without this, `clearMissingOutputs` staying on the
 * plain deferred `mutate()` path let it replay out of order relative to an
 * eagerly-overlaid `updateMissingOutputs`, silently dropping the newer
 * update or resurrecting rounds a clear was supposed to erase.
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

function descriptorFromConfig(
  stream: StreamTabId,
  executionId: ExecutionId,
  config: AgentConfig,
): RunDescriptor {
  return buildRunDescriptor({
    streamId: stream,
    executionId,
    agent: config.agent,
    category: config.agentCategory,
  });
}

/**
 * A stream's executionId, preferring the canonical `runDescriptor.executionId`
 * over the legacy top-level `executionId` field written before descriptors
 * existed. Both fields are set together on new writes (see `setTaskState`),
 * so this only matters for meta read from older on-disk data.
 */
function executionIdFromMeta(
  meta: StreamTabMeta | undefined,
): ExecutionId | undefined {
  return meta?.runDescriptor?.executionId ?? meta?.executionId;
}

/**
 * Every per-stream field this store tracks, keyed by stream id in ONE map
 * (`records`) instead of 17 independently hand-synced parallel maps/sets (9
 * accumulator fields, `seeded`/`seedChain` seeding bookkeeping, 5 overlay
 * fields, and the cached `KVStore` handle). Because every field for a stream
 * lives on the same object, dropping a stream's memory is one
 * `records.delete(stream)` — every field disappears with it BY CONSTRUCTION.
 * The old design needed a hand-maintained `perStreamStores()` list (#7892)
 * to keep `evict()`/`evictAll()`/`allKnownStreams()` from drifting apart —
 * and that list had already drifted once (`allKnownStreams()` omitted
 * `metaOverlays`) before #7892 unified it. A single record makes that whole
 * drift class structurally impossible: there is no second list to omit a
 * field from.
 *
 * `streamVersions` (must survive eviction to keep guarding in-flight seed
 * races) and `writeMutexes` (keyed by the compound `${stream}::${key}`, not
 * a bare stream id) stay as their own maps on the store — the same two
 * exclusions #7892 already carved out of `perStreamStores()`.
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
  /** Immutable run descriptor parsed/emitted once per execution stream. */
  runDescriptor: RunDescriptor | undefined;
  /** Current run config, hydrated from executions/{id}/config.json. */
  runConfig: AgentConfig | undefined;

  // -- Lazy seeding: a stream's existing disk data is read into memory BEFORE
  // the first mutation so an accumulate/merge can't overwrite unloaded disk
  // data. `seeded` = this stream's memory is current; `seedChain` serializes
  // refresh/seed/mutate for it.
  seeded: boolean;
  seedChain: Promise<void> | undefined;

  // -- Overlays: patches applied eagerly to memory while a seed is in flight,
  // so `applyStreamData`'s post-seed reconciliation can replay them on top of
  // the freshly-read disk state — an eager write racing ahead of its own seed
  // is never clobbered by that seed's raw disk read. See `mutateWithOverlay`.
  metaOverlay: boolean;
  outputFileOverlay: OutputFilesPatch | undefined;
  missingOutputsOverlay: RoundOverlay<string> | undefined;
  compileFailuresOverlay: Map<number, CompileFailure[] | null> | undefined;
  usageOverlay: Map<StorageKey, TokenUsageStats> | undefined;

  // -- Cached KVStore handle for this stream's sidecar directory. ----------
  kv: KVStore | undefined;
  writeKv: KVStore | undefined;
}

type StagedDeletionPhase = 'live' | 'transitioning' | 'staged' | 'unavailable';

interface StagedDeletionState {
  writes: Map<string, unknown>;
  /** Namespace authority and whether failed ownership may mirror writes. */
  phase: StagedDeletionPhase;
  /** One recovery owns namespace repair and buffered-write replay at a time. */
  recovery?: Promise<void>;
  settled: Promise<void>;
  resolveSettled: () => void;
}

export class StreamSnapshotStore {
  private readonly records = new Map<StreamTabId, StreamRecord>();
  /**
   * Writes arriving while a stream's live directory is reversibly staged.
   * Keeping the latest value per sidecar makes the staging rename a real
   * transaction boundary: commit discards them, rollback replays them only
   * after the live namespace has been restored.
   */
  private readonly stagedDeletions = new Map<
    StreamTabId,
    StagedDeletionState
  >();
  private readonly failedRollbacks = new Map<
    StreamTabId,
    StagedDeletionState
  >();

  // -- Per (stream, category) serialized write locks -------------------------
  private readonly writeMutexes = new Map<string, Mutex>();

  private readonly streamVersions = new Map<StreamTabId, number>();
  private hasAuthoritativeStreamSet = false;

  private getOrCreateRecord(stream: StreamTabId): StreamRecord {
    let record = this.records.get(stream);
    if (!record) {
      record = {
        outputFiles: {},
        missingOutputs: {},
        compileFailures: {},
        usage: new Map(),
        usageUnparsed: new Map(),
        workPlan: EMPTY_WORK_PLAN,
        meta: undefined,
        runDescriptor: undefined,
        runConfig: undefined,
        seeded: false,
        seedChain: undefined,
        metaOverlay: false,
        outputFileOverlay: undefined,
        missingOutputsOverlay: undefined,
        compileFailuresOverlay: undefined,
        usageOverlay: undefined,
        kv: undefined,
        writeKv: undefined,
      };
      this.records.set(stream, record);
    }
    return record;
  }

  private kv(streamId: StreamTabId): KVStore {
    const record = this.getOrCreateRecord(streamId);
    if (!record.kv) {
      record.kv = new KVStore(streamDataDir(streamId));
    }
    return record.kv;
  }

  /** Strict write handle; read callers retain the KV store's fallback policy. */
  private writeKv(streamId: StreamTabId): KVStore {
    const record = this.getOrCreateRecord(streamId);
    if (!record.writeKv) {
      record.writeKv = new KVStore(streamDataDir(streamId), {
        throwOnErrors: true,
      });
    }
    return record.writeKv;
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
    return this.streamVersions.get(stream) ?? 0;
  }

  private bumpStreamVersion(stream: StreamTabId): void {
    this.streamVersions.set(stream, this.streamVersion(stream) + 1);
  }

  private canMutateSynchronously(stream: StreamTabId): boolean {
    const record = this.records.get(stream);
    if (record?.seeded) return true;

    if (this.hasAuthoritativeStreamSet && !record?.seedChain) {
      this.getOrCreateRecord(stream).seeded = true;
      return true;
    }

    return false;
  }

  /**
   * Persist already-migrated durable facts directly from the session event
   * plane.
   */
  attachSessionEvents(events: SessionEventHub): () => void {
    const detachRunEvents = events.subscribe(
      (sessionEvent) => {
        if (sessionEvent.scope !== 'run') return;
        const { event } = sessionEvent;

        switch (event.type) {
          case 'run.config':
            this.setTaskState(
              event.streamId,
              agentConfigToTaskState(event.config),
              event.executionId,
            );
            return;
          case 'usage':
            this.handleSessionUsageEvent(event.data);
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
          case 'goalPaused':
          default:
            return;
        }
      },
      {
        scope: 'run',
        types: [
          'run.config',
          'usage',
          'updateTodos',
          'updatePlan',
          'addOutputFiles',
          'updateMissingOutputs',
          'updateCompileFailures',
          'goalPaused',
        ],
      },
    );
    const detachSessionEvents = events.subscribe(
      (sessionEvent) => {
        if (sessionEvent.scope !== 'session') return;
        switch (sessionEvent.event.type) {
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

  private handleSessionUsageEvent(data: unknown): void {
    const payload = UsageRunEventDataSchema.safeParse(data);
    if (!payload.success) return;
    void this.addUsage(
      payload.data.streamId,
      payload.data.storageKey as StorageKey,
      payload.data.usage,
    );
  }

  /**
   * Run a mutation only after existing disk state has been loaded. After an
   * authoritative full load, streams outside that loaded set are treated as new
   * and mutate synchronously so UI callers can read back their own writes.
   * Partial preloads intentionally do not enable this fast path because other
   * streams may still have sidecars on disk.
   */
  private mutate<T>(stream: StreamTabId, apply: () => T): T | undefined {
    const version = this.streamVersion(stream);
    if (this.canMutateSynchronously(stream)) return apply();

    this.queueAfterSeed(stream, version, apply);
    return undefined;
  }

  private queueAfterSeed(
    stream: StreamTabId,
    version: number,
    apply: () => unknown,
  ): Promise<void> {
    const next: Promise<void> = this.ensureSeeded(stream, version)
      .then(() => {
        if (this.streamVersion(stream) !== version) return;
        const record = this.records.get(stream);
        if (!record?.seeded) {
          if (record?.seedChain === next) {
            record.seedChain = undefined;
          }
          return;
        }
        apply();
      })
      .catch((err: unknown) => {
        const record = this.records.get(stream);
        if (!record?.seeded && record?.seedChain === next) {
          record.seedChain = undefined;
        }
        logger.warn(CHANNEL, `Deferred update failed for stream ${stream}`, {
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
    if (this.records.get(stream)?.seeded) return;
    const data = await readStreamData(this.kv(stream));
    if (this.streamVersion(stream) !== version) return;
    await this.applyStreamData(stream, data);
  }

  // ==========================================================================
  // Mutators (mirror the consolidated managers)
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
   * records `overlayPatch` on the stream's record via `setOverlay` (merged
   * with anything still pending from an earlier unseeded mutation via
   * `mergePatch`), leaving `overlayPatch` `undefined` to skip recording
   * (used for effectively-empty patches). `applyStreamData`'s post-seed
   * reconciliation then replays the overlay on top of the freshly-read disk
   * state and persists it there, so an eager write racing ahead of its own
   * seed is never clobbered by that seed's raw disk read. This is the
   * guarantee `addOutputFiles`/`addUsage` used to hand-roll individually;
   * every round/usage mutator now shares it here, so a future one inherits
   * it by construction instead of needing its own bespoke overlay block.
   */
  private mutateWithOverlay<T, P>(
    stream: StreamTabId,
    overlayPatch: P | undefined,
    getOverlay: (record: StreamRecord) => P | undefined,
    setOverlay: (record: StreamRecord, value: P) => void,
    mergePatch: (existing: P | undefined, patch: P) => P,
    applyToMemory: () => T,
    persist: () => void,
  ): { result: T; pending: Promise<void> | undefined } {
    const result = applyToMemory();

    if (this.canMutateSynchronously(stream)) {
      persist();
      return { result, pending: undefined };
    }

    const version = this.streamVersion(stream);
    if (overlayPatch !== undefined) {
      const record = this.getOrCreateRecord(stream);
      setOverlay(record, mergePatch(getOverlay(record), overlayPatch));
    }
    return {
      result,
      pending: this.queueAfterSeed(stream, version, () => undefined),
    };
  }

  addOutputFiles(
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
      patch,
      (record) => record.outputFileOverlay,
      (record, value) => {
        record.outputFileOverlay = value;
      },
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

  updateMissingOutputs(
    stream: StreamTabId,
    filesByRound: RoundIndexed<string>,
  ): void {
    const patch = this.parseRoundPatch<string>(filesByRound, (raw) =>
      z.array(z.string()).parse(Array.isArray(raw) ? raw : []),
    );
    if (patch.size === 0) return;

    this.mutateWithOverlay(
      stream,
      { reset: false, patch },
      (record) => record.missingOutputsOverlay,
      (record, value) => {
        record.missingOutputsOverlay = value;
      },
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

  updateCompileFailures(
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
      patch,
      (record) => record.compileFailuresOverlay,
      (record, value) => {
        record.compileFailuresOverlay = value;
      },
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
   * Accumulate usage per run (mirrors UsageStatsManager.setRunUsage). Returns
   * the accumulated value for the run so callers can forward it to the UI.
   */
  addUsage(
    stream: StreamTabId,
    storageKey: StorageKey,
    usage: TokenUsageStats,
  ): UsageUpdateResult {
    const delta = TokenUsageStatsParsingSchema.parse(usage);
    const version = this.streamVersion(stream);
    const overlayPatch = isEmptyUsage(delta)
      ? undefined
      : new Map<StorageKey, TokenUsageStats>([[storageKey, delta]]);

    const { result: accumulated, pending } = this.mutateWithOverlay(
      stream,
      overlayPatch,
      (record) => record.usageOverlay,
      (record, value) => {
        record.usageOverlay = value;
      },
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
        !this.records.get(stream)?.seeded
      ) {
        return undefined;
      }
      return this.records.get(stream)?.usage.get(storageKey);
    });
  }

  // ==========================================================================
  // Read accessors over in-memory accumulated state (replace manager getters)
  // ==========================================================================

  // Deep-enough copies (fresh record, fresh per-round array): a caller that
  // mutates the returned value — including pushing into a returned round's
  // array — can never corrupt these in-memory accumulators. A shallow
  // `{ ...map }` spread would share the per-round arrays by reference.
  getOutputFiles(stream: StreamTabId): RoundIndexed<OutputFileInfo> {
    return cloneRoundIndexed(this.records.get(stream)?.outputFiles);
  }

  getMissingOutputs(stream: StreamTabId): RoundIndexed<string> {
    return cloneRoundIndexed(this.records.get(stream)?.missingOutputs);
  }

  getCompileFailures(stream: StreamTabId): RoundIndexed<CompileFailure> {
    return cloneRoundIndexed(this.records.get(stream)?.compileFailures);
  }

  getRunUsage(stream: StreamTabId): Map<string, TokenUsageStats> {
    return new Map(this.records.get(stream)?.usage ?? []);
  }

  /** Flattened set of known output-file paths for a stream. */
  getKnownFilePaths(
    stream: StreamTabId,
    options: { workspaceOnly?: boolean } = {},
  ): Set<string> {
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
   * the shared `reset`-aware overlay) rather than the plain deferred
   * `mutate()` path, so a clear and an update racing on the same unseeded
   * stream replay in call order instead of the clear always landing last.
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
  clearMissingOutputs(stream: StreamTabId): void {
    let existed = false;
    this.mutateWithOverlay(
      stream,
      { reset: true, patch: new Map<number, string[] | null>() },
      (record) => record.missingOutputsOverlay,
      (record, value) => {
        record.missingOutputsOverlay = value;
      },
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
  // Lifecycle (replace manager evict/evictAll)
  // ==========================================================================

  /** Drop a stream's in-memory state. Disk cleanup is the caller's job. */
  evict(stream: StreamTabId): void {
    this.bumpStreamVersion(stream);
    this.records.delete(stream);
    for (const key of [...this.writeMutexes.keys()]) {
      if (key.startsWith(`${stream}::`)) this.writeMutexes.delete(key);
    }
  }

  evictAll(): void {
    for (const stream of this.records.keys()) this.bumpStreamVersion(stream);
    this.records.clear();
    this.writeMutexes.clear();
    for (const state of this.stagedDeletions.values()) state.resolveSettled();
    this.stagedDeletions.clear();
    this.failedRollbacks.clear();
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
    let entries: [string, number][];
    try {
      entries = await StorageFS.readDir(STREAM_DATA_DELETION_DIR);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        entries = [];
      } else {
        throw error;
      }
    }

    const restored: StreamTabId[] = [];
    const pendingCleanup: StreamTabId[] = [];
    const discarded: StreamTabId[] = [];
    await pMap(
      entries.filter(([, type]) => isDirectory(type)),
      async ([encoded]) => {
        const parsedStream = StreamTabIdSchema.safeParse(
          decodeStreamId(encoded),
        );
        if (!parsedStream.success) {
          logger.warn(
            CHANNEL,
            `Ignoring invalid staged snapshot directory ${encoded}`,
            { data: parsedStream.error },
          );
          return;
        }
        const stream = parsedStream.data;
        if (this.stagedDeletions.has(stream)) return;

        const stagedDir = stagedStreamDataDir(stream);
        const liveDir = streamDataDir(stream);
        const failedWrites = this.failedRollbacks.get(stream);
        if (failedWrites) {
          const hasLiveData = await storagePathExists(liveDir);
          const liveWasAuthoritative =
            failedWrites.phase === 'live' && hasLiveData;
          await this.recoverFailedRollback(stream, failedWrites);
          if (liveWasAuthoritative) discarded.push(stream);
          else if (liveStreams.has(stream)) restored.push(stream);
          else pendingCleanup.push(stream);
          return;
        }
        const hasLiveData = await storagePathExists(liveDir);
        if (!hasLiveData) {
          await StorageFS.ensureDir(STREAM_DATA_DIR);
          await StorageFS.rename(stagedDir, liveDir);
          const record = this.records.get(stream);
          if (record) {
            record.kv = undefined;
            record.writeKv = undefined;
          }
          if (liveStreams.has(stream)) restored.push(stream);
          else pendingCleanup.push(stream);
          return;
        }

        await StorageFS.delete(stagedDir, { recursive: true });
        discarded.push(stream);
      },
      { concurrency: SEED_IO_CONCURRENCY },
    );
    await pMap(
      [...this.failedRollbacks],
      async ([stream, state]) => {
        if (!liveStreams.has(stream)) return;
        await this.recoverFailedRollback(stream, state);
      },
      { concurrency: SEED_IO_CONCURRENCY },
    );
    return { restored, pendingCleanup, discarded };
  }

  /** Restore writes buffered behind a staging attempt after live data returns. */
  private async replayStagedWrites(
    stream: StreamTabId,
    state: StagedDeletionState,
  ): Promise<void> {
    while (state.writes.size > 0) {
      const writes = [...state.writes];
      state.writes.clear();
      try {
        await Promise.all(
          writes.map(([key, value]) => this.queueWrite(stream, key, value)),
        );
      } catch (error) {
        for (const [key, value] of writes) {
          if (!state.writes.has(key)) state.writes.set(key, value);
        }
        throw error;
      }
    }
  }

  /** Drain buffered writes and release every owner without an await-sized gap. */
  private async drainStagedWrites(
    stream: StreamTabId,
    state: StagedDeletionState,
  ): Promise<void> {
    while (true) {
      await this.replayStagedWrites(stream, state);
      if (state.writes.size > 0) continue;
      this.releaseStagedOwnership(stream, state);
      return;
    }
  }

  private releaseStagedOwnership(
    stream: StreamTabId,
    state: StagedDeletionState,
  ): void {
    if (state.writes.size > 0 || state.recovery) return;
    if (this.failedRollbacks.get(stream) === state) {
      this.failedRollbacks.delete(stream);
    }
    if (this.stagedDeletions.get(stream) === state) {
      this.stagedDeletions.delete(stream);
      state.resolveSettled();
    }
  }

  /**
   * Repair a failed rollback exactly once, then release its write buffer only
   * after the namespace is live and no buffered values remain.
   */
  private recoverFailedRollback(
    stream: StreamTabId,
    state: StagedDeletionState,
  ): Promise<void> {
    if (this.failedRollbacks.get(stream) !== state) return Promise.resolve();
    if (state.recovery) return state.recovery;

    let recovered = false;
    const recovery = (async () => {
      if (canUseStreamDataDir(stream)) {
        const stagedDir = stagedStreamDataDir(stream);
        const liveDir = streamDataDir(stream);
        const liveWasAuthoritative = state.phase === 'live';
        const [hasLiveData, hasStagedData] = await Promise.all([
          storagePathExists(liveDir),
          storagePathExists(stagedDir),
        ]);

        if (liveWasAuthoritative && hasLiveData) {
          if (hasStagedData) {
            await StorageFS.delete(stagedDir, { recursive: true });
          }
        } else if (hasStagedData) {
          state.phase = 'staged';
          if (hasLiveData) {
            await StorageFS.delete(liveDir, { recursive: true });
          }
          await StorageFS.ensureDir(STREAM_DATA_DIR);
          state.phase = 'transitioning';
          await StorageFS.rename(stagedDir, liveDir);
          const record = this.records.get(stream);
          if (record) {
            record.kv = undefined;
            record.writeKv = undefined;
          }
        } else if (!hasLiveData && !liveWasAuthoritative) {
          state.phase = 'unavailable';
          throw new Error(
            `Stream ${stream} has no snapshot namespace to recover`,
          );
        }
      }

      state.phase = 'live';
      await this.drainStagedWrites(stream, state);
      recovered = true;
    })();
    const trackedRecovery = recovery.finally(() => {
      if (state.recovery === trackedRecovery) {
        state.recovery = undefined;
        if (recovered) this.releaseStagedOwnership(stream, state);
      }
    });
    state.recovery = trackedRecovery;
    return trackedRecovery;
  }

  /** Release ownership of a stream after its staged transaction finishes. */
  private settleStagedDeletion(
    stream: StreamTabId,
    state: StagedDeletionState,
  ): void {
    if (this.stagedDeletions.get(stream) === state) {
      this.stagedDeletions.delete(stream);
    }
    state.resolveSettled();
  }

  /**
   * Atomically move a stream's sidecars out of the live namespace while
   * keeping its in-memory record available until the transcript registry
   * decides whether deletion commits.
   */
  async stageDeleteStream(
    stream: StreamTabId,
  ): Promise<StagedStreamSnapshotDeletion> {
    const activeDeletion = this.stagedDeletions.get(stream);
    if (activeDeletion) {
      await activeDeletion.settled;
      return this.stageDeleteStream(stream);
    }
    const failedRollback = this.failedRollbacks.get(stream);
    if (failedRollback) {
      await this.recoverFailedRollback(stream, failedRollback);
      return this.stageDeleteStream(stream);
    }
    let resolveSettled = () => {};
    const settlement = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const state: StagedDeletionState = {
      writes: new Map(),
      phase: 'live',
      settled: settlement,
      resolveSettled,
    };
    this.stagedDeletions.set(stream, state);

    try {
      if (canUseStreamDataDir(stream)) {
        const hasStagedData = await storagePathExists(
          stagedStreamDataDir(stream),
        );
        if (hasStagedData) {
          state.phase = 'staged';
          throw new Error(
            `Stream ${stream} has an unreconciled snapshot deletion`,
          );
        }
        state.phase = 'live';
      }
      // Let hydration finish before staging. A record with `seeded === false`
      // may already contain sidecars while execution-config hydration is still
      // in flight, so invalidating that seed would make neither disk nor memory
      // authoritative for rollback.
      let seedChain = this.records.get(stream)?.seedChain;
      while (seedChain) {
        await seedChain;
        const current = this.records.get(stream)?.seedChain;
        if (!current || current === seedChain) break;
        seedChain = current;
      }

      const pending = this.cancelPendingWritesForStream(stream);
      this.bumpStreamVersion(stream);
      await Promise.all(pending);

      const canStage = canUseStreamDataDir(stream);
      const liveDir = canStage ? streamDataDir(stream) : undefined;
      const stagedDir = canStage ? stagedStreamDataDir(stream) : undefined;
      const hasLiveData =
        !liveDir || !stagedDir || (await storagePathExists(liveDir));
      if (liveDir && stagedDir && hasLiveData) {
        await StorageFS.ensureDir(STREAM_DATA_DELETION_DIR);
        state.phase = 'transitioning';
        await StorageFS.rename(liveDir, stagedDir);
        state.phase = 'staged';
      }

      let settled = false;
      return {
        commit: async () => {
          if (settled) return;
          settled = true;
          this.evict(stream);
          try {
            if (state.phase === 'staged' && stagedDir) {
              try {
                await StorageFS.delete(stagedDir, { recursive: true });
              } catch (error) {
                logger.warn(
                  CHANNEL,
                  `Stream ${stream} was deleted, but staged snapshot cleanup was incomplete.`,
                  { data: error },
                );
              }
            }
          } finally {
            this.settleStagedDeletion(stream, state);
          }
        },
        rollback: async () => {
          if (settled) return;
          settled = true;
          try {
            if (state.phase === 'staged' && stagedDir && liveDir) {
              state.phase = 'transitioning';
              await StorageFS.rename(stagedDir, liveDir);
              state.phase = 'live';
            }
            await this.drainStagedWrites(stream, state);
          } catch (error) {
            const failures: unknown[] = [error];
            if (state.phase !== 'live' && canUseStreamDataDir(stream)) {
              try {
                const [hasLiveData, hasStagedData] = await Promise.all([
                  storagePathExists(streamDataDir(stream)),
                  storagePathExists(stagedStreamDataDir(stream)),
                ]);
                if (hasStagedData) state.phase = 'staged';
                else if (hasLiveData) state.phase = 'live';
                else state.phase = 'unavailable';
              } catch (recoveryError) {
                failures.push(recoveryError);
              }
            }
            this.failedRollbacks.set(stream, state);
            if (failures.length > 1) {
              throw new AggregateError(
                failures,
                `Failed to roll back snapshot deletion for ${stream} and inspect its namespace`,
              );
            }
            throw error;
          } finally {
            this.settleStagedDeletion(stream, state);
          }
        },
      };
    } catch (error) {
      const failures: unknown[] = [error];
      this.failedRollbacks.set(stream, state);
      try {
        if (state.phase === 'live') {
          await this.drainStagedWrites(stream, state);
        }
      } catch (recoveryError) {
        failures.push(recoveryError);
      } finally {
        this.settleStagedDeletion(stream, state);
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          `Failed to stage snapshot deletion for ${stream} and restore buffered writes`,
        );
      }
      throw error;
    }
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

  setTodos(stream: StreamTabId, todos: TodoItem[]): void {
    this.mutate(stream, () => {
      const record = this.getOrCreateRecord(stream);
      record.workPlan = { ...record.workPlan, todos };
      this.writeWorkPlan(stream, record.workPlan);
    });
  }

  setPlan(stream: StreamTabId, plan: Plan | null): void {
    this.mutate(stream, () => {
      const record = this.getOrCreateRecord(stream);
      record.workPlan = {
        ...record.workPlan,
        plan,
        planSummary: plan ? planSummaryLine(plan.objective) : null,
      };
      this.writeWorkPlan(stream, record.workPlan);
    });
  }

  getWorkPlan(stream: StreamTabId): WorkPlanSnapshot {
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
      schemaVersion: RUN_DESCRIPTOR_SCHEMA_VERSION,
    };
    record.meta = next;
    return next;
  }

  private writeMeta(stream: StreamTabId, next: StreamTabMeta): void {
    // activeRunId is legacy and never re-written. Persist every explicitly-set
    // field (`!== undefined`, not falsy) so on-disk and in-memory never diverge
    // — e.g. clearing a description to "" must round-trip, not silently vanish.
    const file: StreamTabMeta = {
      schemaVersion: RUN_DESCRIPTOR_SCHEMA_VERSION,
      ...(next.executionId !== undefined && { executionId: next.executionId }),
      ...(next.runDescriptor !== undefined && {
        runDescriptor: next.runDescriptor,
      }),
      ...(next.taskState !== undefined &&
        next.runDescriptor === undefined && { taskState: next.taskState }),
      ...(next.parentStreamId !== undefined && {
        parentStreamId: next.parentStreamId,
      }),
      ...(next.description !== undefined && { description: next.description }),
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
  // Meta accessors, setters, and queries (replace StreamMetaManager)
  // ==========================================================================

  /**
   * Set task state, optionally with the execution id, in a SINGLE meta.json
   * write (callers that have both should pass both so meta isn't written twice).
   */
  setTaskState(
    stream: StreamTabId,
    taskState: TaskState,
    executionId?: ExecutionId,
  ): void {
    const config = taskState.agentConfig;
    const record = this.getOrCreateRecord(stream);
    record.runConfig = config;
    const descriptor = executionId
      ? descriptorFromConfig(stream, executionId, config)
      : undefined;
    if (descriptor) record.runDescriptor = descriptor;
    this.queueMetaPatch(stream, {
      ...(executionId ? { executionId } : {}),
      ...(descriptor ? { runDescriptor: descriptor } : {}),
    });
  }

  setParentStream(
    child: StreamTabId,
    parent: StreamTabId | null | undefined,
  ): void {
    this.queueMetaPatch(child, { parentStreamId: parent ?? undefined });
  }

  setDescription(stream: StreamTabId, description: string): void {
    this.queueMetaPatch(stream, { description });
  }

  getTaskState(stream: StreamTabId): TaskState | undefined {
    const config = this.records.get(stream)?.runConfig;
    return config ? agentConfigToTaskState(config) : undefined;
  }

  getRunDescriptor(stream: StreamTabId): RunDescriptor | undefined {
    return this.records.get(stream)?.runDescriptor;
  }

  getRunConfig(stream: StreamTabId): AgentConfig | undefined {
    return this.records.get(stream)?.runConfig;
  }

  getExecutionId(stream: StreamTabId): ExecutionId | undefined {
    // executionId is validated to a real ExecutionId at the single disk-read
    // entry (`readMeta`), so no cast/re-validation is needed here.
    return this.records.get(stream)?.meta?.executionId;
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
   * every persisted stream (the `executionStreamResolver` meta-match, bulk
   * admin sweeps in `SessionStores`) only ever need this one field, so this
   * reads just `meta.json` rather than the full 6-file `readStreamData()`.
   */
  async readPersistedExecutionId(
    stream: StreamTabId,
  ): Promise<ExecutionId | undefined> {
    return executionIdFromMeta(await readMeta(this.kv(stream)));
  }

  /**
   * Whether a stream has a persisted `workPlan.json` sidecar — an existence
   * check only (a single stat via `KVStore.exists`), not a read. Used by the
   * resolver to disambiguate between multiple persisted streams that share an
   * `executionId` (e.g. a parent orchestrator tab and a child stream): the
   * candidate that actually holds durable todo/plan data is preferred over a
   * bare `meta.json`-only match.
   */
  async hasPersistedWorkPlan(stream: StreamTabId): Promise<boolean> {
    return this.kv(stream).exists(STREAM_DATA_KEYS.WORK_PLAN);
  }

  /**
   * Archived pre-#3061 per-run instruction text, if this stream still has
   * one on disk. See {@link readLegacyInstruction} (streamSnapshotRead.ts)
   * for why this stays supported. Read-only; never seeds or writes memory.
   * Uses the in-memory `meta` once seeded (the caller's normal `load()`
   * ordering) but falls back to a disk read so this is also safe to call
   * standalone, before a stream has been seeded.
   */
  async readLegacyInstruction(
    stream: StreamTabId,
  ): Promise<LegacyInstructionEntry | null> {
    const record = this.records.get(stream);
    const meta = record?.seeded
      ? record.meta
      : (await readStreamData(this.kv(stream))).meta;
    return readLegacyInstructionFromDisk(this.kv(stream), meta);
  }

  getParentStreamId(stream: StreamTabId): StreamTabId | undefined {
    return this.records.get(stream)?.meta?.parentStreamId;
  }

  getDescription(stream: StreamTabId): string | undefined {
    return this.records.get(stream)?.meta?.description;
  }

  /** Read-only view of stream→executionId for waiting-stream detection. */
  getExecutionIdMap(): ReadonlyMap<StreamTabId, ExecutionId> {
    const map = new Map<StreamTabId, ExecutionId>();
    for (const [stream, record] of this.records) {
      if (record.meta?.executionId) map.set(stream, record.meta.executionId);
    }
    return map;
  }

  /** Stream IDs that still have execution sidecar state. */
  getTaskStateStreams(): Set<StreamTabId> {
    const streams = new Set<StreamTabId>();
    for (const [stream, record] of this.records) {
      if (record.runConfig !== undefined) streams.add(stream);
    }
    return streams;
  }

  /**
   * Workflow stream IDs whose taskState's agentConfig matches `match`. Used by
   * command-palette pack/clean to clear missing-output markers across every tab
   * that surfaced markers for the cleaned files. Both sides are canonicalized
   * (agent source prefixes stripped, paths normalized to forward slashes).
   */
  findWorkflowStreamsMatching(match: WorkflowStreamMatch): StreamTabId[] {
    const wantAgent = getCleanAgentName(match.agent);
    const wantFile = normalizeFilePath(match.inputFile);
    const wantOutputFiles = normalizeOutputFiles(match.outputFiles);
    const result: StreamTabId[] = [];
    for (const [stream, record] of this.records) {
      const cfg = record.runConfig;
      if (!cfg || cfg.agentCategory !== 'workflow') continue;
      const cfgPrimaryInput = normalizeFilePath(cfg.inputFiles[0] ?? '');
      if (
        getCleanAgentName(cfg.agent) !== wantAgent ||
        cfg.model !== match.model ||
        cfgPrimaryInput !== wantFile ||
        !sameOutputFiles(normalizeOutputFiles(cfg.outputFiles), wantOutputFiles)
      ) {
        continue;
      }
      result.push(stream);
    }
    return result;
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
    const stagedDeletion = this.stagedDeletions.get(stream);
    if (stagedDeletion) {
      stagedDeletion.writes.set(key, value);
      return;
    }
    const failedRollback = this.failedRollbacks.get(stream);
    if (failedRollback) {
      failedRollback.writes.set(key, value);
      if (failedRollback.phase === 'live' && !failedRollback.recovery) {
        void this.queueWrite(stream, key, value)
          .then(() => {
            if (
              this.failedRollbacks.get(stream) === failedRollback &&
              failedRollback.writes.get(key) === value
            ) {
              failedRollback.writes.delete(key);
              this.releaseStagedOwnership(stream, failedRollback);
            }
          })
          .catch((err: unknown) =>
            logger.warn(
              CHANNEL,
              `Failed to persist ${key}.json for stream ${stream}; sidecar remains buffered.`,
              { data: err },
            ),
          );
      }
      return;
    }
    this.writeUnbuffered(stream, key, value);
  }

  private writeUnbuffered(
    stream: StreamTabId,
    key: string,
    value: unknown,
  ): void {
    void this.queueWrite(stream, key, value).catch((err: unknown) =>
      logger.warn(
        CHANNEL,
        `Failed to persist ${key}.json for stream ${stream}; sidecar may be stale.`,
        { data: err },
      ),
    );
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
      return this.writeKv(stream).write(key, value);
    });
  }

  private async flushWritesForStream(stream: StreamTabId): Promise<void> {
    const prefix = `${stream}::`;
    await Promise.all(
      [...this.writeMutexes]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, mutex]) => mutex.waitForUnlock()),
    );
  }

  private cancelPendingWritesForStream(stream: StreamTabId): Promise<void>[] {
    const prefix = `${stream}::`;
    const pending: Promise<void>[] = [];
    for (const [key, mutex] of this.writeMutexes) {
      if (!key.startsWith(prefix)) continue;
      pending.push(mutex.waitForUnlock());
      this.writeMutexes.delete(key);
    }
    return pending;
  }

  /** Await deferred (seed-gated) mutations, then all in-flight writes. */
  async flush(): Promise<void> {
    await Promise.all(
      [...this.records.values()]
        .map((record) => record.seedChain)
        .filter((chain): chain is Promise<void> => chain !== undefined),
    );
    try {
      await pMap(
        [...this.failedRollbacks],
        ([stream, state]) => this.recoverFailedRollback(stream, state),
        { concurrency: SEED_IO_CONCURRENCY },
      );
    } finally {
      await Promise.all(
        [...this.writeMutexes.values()].map((mutex) => mutex.waitForUnlock()),
      );
    }
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
    const seedChain = this.records.get(streamId)?.seedChain;
    if (seedChain) {
      await seedChain;
    }
    if (this.records.get(streamId)?.seeded) {
      return this.snapshotFromMemory(streamId);
    }
    return assembleSnapshot(streamId, await readStreamData(this.kv(streamId)));
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
      legacyKeys: [],
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
    const seedChain = this.records.get(streamId)?.seedChain;
    if (seedChain) {
      await seedChain;
    }
    if (this.records.get(streamId)?.seeded) {
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
    this.hasAuthoritativeStreamSet = false;
    this.evictStreamsExcept(new Set(streamIds));
    await this.seedStreams(streamIds);
    this.hasAuthoritativeStreamSet = true;
    await this.backfillDescriptionsFromExecutionMeta();
  }

  /**
   * Warm selected stream sidecars without claiming that `streamIds` is the full
   * stream set. Use this when a host only has a partial rail snapshot at
   * startup; later mutations for other streams must still seed from disk before
   * writing.
   */
  async preload(streamIds: readonly StreamTabId[]): Promise<void> {
    await this.seedStreams(streamIds);
    await this.backfillDescriptionsFromExecutionMeta();
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
    const existing = this.records.get(stream);
    if (existing) existing.seeded = false;
    const prev = existing?.seedChain ?? Promise.resolve();
    const next = prev.then(async () => {
      if (this.streamVersion(stream) !== version) return;
      await this.flushWritesForStream(stream);
      if (this.streamVersion(stream) !== version) return;
      const record = this.records.get(stream);
      if (record) {
        record.kv = undefined;
        record.writeKv = undefined;
      }
      const data = await readStreamData(this.kv(stream));
      if (this.streamVersion(stream) !== version) return;
      await this.applyStreamData(stream, data);
    });
    this.getOrCreateRecord(stream).seedChain = next;
    return next;
  }

  private parseLegacyTaskState(
    stream: StreamTabId,
    meta: StreamTabMeta,
  ): TaskState | undefined {
    if (meta.taskState === undefined) return undefined;
    const parsed = TaskStateSchema.safeParse(meta.taskState);
    if (parsed.success) {
      logger.warn(
        CHANNEL,
        `Loaded legacy taskState for stream ${stream}; run config should come from execution config on new writes.`,
        { data: { stream, executionId: meta.executionId } },
      );
      return parsed.data;
    }

    logger.warn(
      CHANNEL,
      `Could not parse legacy taskState for stream ${stream}; ignoring legacy run config.`,
      {
        data: {
          stream,
          executionId: meta.executionId,
          error: z.prettifyError(parsed.error),
        },
      },
    );
    return undefined;
  }

  private async hydrateRunStateFromMeta(
    stream: StreamTabId,
    meta: StreamTabMeta,
  ): Promise<HydratedRunState> {
    const executionId = executionIdFromMeta(meta);
    let descriptor = meta.runDescriptor;

    if (executionId) {
      let config: AgentConfig | null = null;
      try {
        config = await getExecutionStore(executionId).readConfig();
      } catch (error) {
        logger.warn(
          CHANNEL,
          `Could not read execution config for stream ${stream}; falling back to legacy taskState.`,
          { data: { stream, executionId, error } },
        );
      }
      if (config) {
        return {
          config,
          descriptor:
            descriptor ?? descriptorFromConfig(stream, executionId, config),
        };
      }
    }

    const legacyTaskState = this.parseLegacyTaskState(stream, meta);
    if (!legacyTaskState) return { descriptor };
    const config = legacyTaskState.agentConfig;
    if (executionId) {
      descriptor =
        descriptor ?? descriptorFromConfig(stream, executionId, config);
    }
    return { config, descriptor };
  }

  /** Seed the in-memory accumulators for one stream + migrate legacy once. */
  private async applyStreamData(
    stream: StreamTabId,
    data: StreamData,
  ): Promise<void> {
    const version = this.streamVersion(stream);
    const record = this.getOrCreateRecord(stream);
    const metaOverlay = record.metaOverlay ? record.meta : undefined;
    const runConfigOverlay =
      metaOverlay !== undefined ? record.runConfig : undefined;
    const runDescriptorOverlay =
      metaOverlay !== undefined ? record.runDescriptor : undefined;
    const usageOverlayToReplay = new Map(record.usageOverlay);
    // Seeded with `data.legacyKeys` unconditionally (unlike the overlay
    // additions below, which are gated on that overlay actually being
    // present): a legacy key with no corresponding overlay data still gets
    // an empty-object write in `writeMergedSidecars`. That's a broader net
    // than the old per-field `has()` guards, but harmless — disk readers
    // (`parsePersistedRoundIndexed` and friends) treat an absent sidecar and
    // an empty-object one identically.
    const sidecarsToWrite = new Set<string>(data.legacyKeys);

    record.outputFiles = data.outputFiles;
    record.missingOutputs = data.missingOutputs;
    record.compileFailures = data.compileFailures;
    record.usage = new Map([...data.usage].filter(([, v]) => !isEmptyUsage(v)));
    record.usageUnparsed = new Map(data.usageUnparsed);
    record.workPlan = data.workPlan;
    record.runDescriptor = undefined;
    record.runConfig = undefined;

    let meta = metaOverlay
      ? { ...(data.meta ?? {}), ...metaOverlay }
      : data.meta;
    let hydrated: HydratedRunState = {};
    if (meta) {
      record.meta = meta;
      hydrated = await this.hydrateRunStateFromMeta(stream, meta);
      if (this.streamVersion(stream) !== version) return;
    } else {
      record.meta = undefined;
    }

    // `record` rides across the hydration await above: records are mutated
    // in place, never replaced, so re-reading its overlay fields here picks
    // up any concurrent eager mutation that landed while hydration was in
    // flight (the exact race #8014 fixed). Never re-resolve the record via
    // `getOrCreateRecord` here — if the stream was evicted during the await,
    // that would resurrect a record for a deleted stream and defeat
    // `writeMergedSidecars`' eviction check (#8226); an orphaned `record` is
    // mutated harmlessly and never written.
    const latestMetaOverlay = record.metaOverlay ? record.meta : undefined;
    if (latestMetaOverlay) {
      meta = { ...(data.meta ?? {}), ...latestMetaOverlay };
      record.meta = meta;
    }
    const latestRunConfigOverlay =
      latestMetaOverlay !== undefined ? record.runConfig : undefined;
    const latestRunDescriptorOverlay =
      latestMetaOverlay !== undefined ? record.runDescriptor : undefined;
    const runConfig =
      latestRunConfigOverlay ?? runConfigOverlay ?? hydrated.config;
    const executionId = executionIdFromMeta(meta);
    const runDescriptor =
      latestRunDescriptorOverlay ??
      runDescriptorOverlay ??
      hydrated.descriptor ??
      (runConfig && executionId
        ? descriptorFromConfig(stream, executionId, runConfig)
        : undefined);
    if (runConfig) record.runConfig = runConfig;
    if (runDescriptor) record.runDescriptor = runDescriptor;
    record.metaOverlay = false;

    const outputFileOverlay = record.outputFileOverlay;
    const missingOutputsOverlay = record.missingOutputsOverlay;
    const compileFailuresOverlay = record.compileFailuresOverlay;
    const usageOverlay = record.usageOverlay;
    if (outputFileOverlay) {
      this.applyRoundPatch((r) => r.outputFiles, record, outputFileOverlay);
      sidecarsToWrite.add(STREAM_DATA_KEYS.OUTPUT_FILES);
      record.outputFileOverlay = undefined;
    }
    if (missingOutputsOverlay) {
      if (missingOutputsOverlay.reset) record.missingOutputs = {};
      this.applyRoundPatch(
        (r) => r.missingOutputs,
        record,
        missingOutputsOverlay.patch,
      );
      sidecarsToWrite.add(STREAM_DATA_KEYS.MISSING_OUTPUTS);
      record.missingOutputsOverlay = undefined;
    }
    if (compileFailuresOverlay) {
      this.applyRoundPatch(
        (r) => r.compileFailures,
        record,
        compileFailuresOverlay,
      );
      sidecarsToWrite.add(STREAM_DATA_KEYS.COMPILE_FAILURES);
      record.compileFailuresOverlay = undefined;
    }
    if (usageOverlay) {
      for (const [storageKey, delta] of usageOverlayToReplay) {
        this.applyUsageDeltaMemory(record, storageKey, delta);
      }
      sidecarsToWrite.add(STREAM_DATA_KEYS.USAGE_STATS);
      record.usageOverlay = undefined;
    }
    record.seeded = true;
    this.writeMergedSidecars(stream, record, sidecarsToWrite);
  }

  /** Persist sidecars from merged memory after seeding and overlays converge. */
  private writeMergedSidecars(
    stream: StreamTabId,
    record: StreamRecord,
    keys: Iterable<string>,
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
      }
    }
  }

  /**
   * One-time backfill for streams with an executionId but no description in
   * meta.json: read it from ExecutionMeta and persist so future loads skip the
   * extra I/O. (Ported from StreamMetaManager.)
   */
  private async backfillDescriptionsFromExecutionMeta(): Promise<void> {
    for (const [streamId, record] of [...this.records]) {
      const meta = record.meta;
      if (!meta?.executionId || meta.description) continue;
      try {
        const execMeta = await getExecutionStore(meta.executionId).readMeta();
        if (execMeta?.description) {
          this.setDescription(streamId, execMeta.description);
        }
      } catch (err) {
        // Best-effort; a missing/corrupt execution store just skips backfill.
        logger.debug(
          CHANNEL,
          `Skipping description backfill for stream ${streamId}`,
          { data: err },
        );
      }
    }
  }
}
