/**
 * Host-agnostic per-stream sidecar persistence.
 *
 * One store, shared by the CLI TUI, VS Code extension, and Electron desktop
 * app, that is the SINGLE writer of `streamData/{id}/*` and the reader that
 * reassembles a {@link StreamSnapshot} for resume. Runtime events are fed into
 * {@link handleProgressEvent}, which persists the same field-scoped files the
 * extension already writes (so all three hosts produce identical on-disk data),
 * plus the `workPlan.json` giving todos/plan a durable home.
 *
 * It consolidates the accumulation logic previously split across the extension's
 * `OutputFilesManager` / `UsageStatsManager` / `StreamMetaManager`, talking to
 * `KVStore` directly via the shared `streamDataDir()` layout. Writes are
 * serialized per (stream, category) so concurrent deltas never interleave.
 *
 * Liveness (active children, RUNNING status) is deliberately NOT persisted —
 * `read()` returns durable display state only; hosts clamp liveness on hydrate.
 */

import pMap from 'p-map';
import { z } from 'zod';

import { getExecutionStore } from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { TaskStateSchema, type TaskState } from '@agent/core/state/TaskState';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import { isFileNotFoundError } from '@common/errors';
import { KVStore } from '@common/storage/KVStore';
import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import * as logger from '@logger/logUtils';
import {
  CompileFailureSchema,
  emptyUsageStats,
  isEmptyUsage,
  OutputFileInfoListSchema,
  PersistedWorkPlanSchema,
  RUN_DESCRIPTOR_SCHEMA_VERSION,
  planSummaryLine,
  RoundKeySchema,
  sumUsageStats,
  TokenUsageStatsParsingSchema,
  buildRunDescriptor,
  type CompileFailure,
  type ExecutionId,
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

import { mapToRecord } from '@shared/progressView/backend/persistence/serializationUtils';
import { StorageFS } from '@utils/files';
import { isDirectory } from '@utils/files/fsEntryType';
import {
  decodeStreamId,
  STREAM_DATA_DIR,
  STREAM_DATA_KEYS,
  streamDataDir,
} from './streamDataPaths';
import {
  assembleSnapshot,
  EMPTY_WORK_PLAN,
  readStreamData,
  type StreamData,
} from './streamSnapshotRead';

const CHANNEL = 'StreamSnapshotStore';

/** Bounded fan-out for seeding many streams' sidecars (mirrors the retired
 *  managers' `pMap` hydration so startup doesn't open a file handle per tab). */
const SEED_IO_CONCURRENCY = 8;

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
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => file.length > 0)
    .sort();
}

function sameOutputFiles(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((file, index) => file === right[index]);
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

export class StreamSnapshotStore {
  // -- In-memory accumulators (one entry per stream that has emitted) --------
  private readonly outputFiles = new Map<
    StreamTabId,
    Map<number, OutputFileInfo[]>
  >();
  private readonly missingOutputs = new Map<
    StreamTabId,
    Map<number, string[]>
  >();
  private readonly compileFailures = new Map<
    StreamTabId,
    Map<number, CompileFailure[]>
  >();
  private readonly usage = new Map<StreamTabId, Map<string, TokenUsageStats>>();
  private readonly workPlan = new Map<StreamTabId, WorkPlanSnapshot>();
  private readonly meta = new Map<StreamTabId, StreamTabMeta>();
  /** Immutable run descriptors parsed/emitted once per execution stream. */
  private readonly runDescriptors = new Map<StreamTabId, RunDescriptor>();
  /** Current run config, hydrated from executions/{id}/config.json. */
  private readonly runConfigs = new Map<StreamTabId, AgentConfig>();

  // -- Per (stream, category) serialized write chains -----------------------
  private readonly pendingWrites = new Map<string, Promise<void>>();

  // -- Lazy seeding: a stream's existing disk data is read into memory BEFORE
  // the first mutation so an accumulate/merge can't overwrite unloaded disk
  // data. `seeded` = streams whose memory is current; `seedChains` serializes
  // refresh/seed/mutate per stream.
  private readonly seeded = new Set<StreamTabId>();
  private readonly seedChains = new Map<StreamTabId, Promise<void>>();
  private readonly metaOverlays = new Set<StreamTabId>();
  private readonly outputFileOverlays = new Map<
    StreamTabId,
    OutputFilesPatch
  >();
  private readonly usageOverlays = new Map<
    StreamTabId,
    Map<StorageKey, TokenUsageStats>
  >();
  private readonly streamVersions = new Map<StreamTabId, number>();
  private hasAuthoritativeStreamSet = false;

  private readonly kvCache = new Map<StreamTabId, KVStore>();

  private kv(streamId: StreamTabId): KVStore {
    let store = this.kvCache.get(streamId);
    if (!store) {
      store = new KVStore(streamDataDir(streamId));
      this.kvCache.set(streamId, store);
    }
    return store;
  }

  private async readPersistedStreamDirs(): Promise<[string, number][]> {
    try {
      return await StorageFS.readDir(STREAM_DATA_DIR);
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
    if (this.seeded.has(stream)) return true;

    if (this.hasAuthoritativeStreamSet && !this.seedChains.has(stream)) {
      this.seeded.add(stream);
      return true;
    }

    return false;
  }

  // ==========================================================================
  // Runtime event ingestion
  // ==========================================================================

  /**
   * Persist durable state carried by a runtime progress event. Each mutation
   * goes through the public store mutators used by the extension and desktop,
   * so all hosts share the same seed-before-write policy.
   */
  handleProgressEvent<K extends ProgressEvent>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void {
    switch (event) {
      case 'addOutputFiles': {
        const p = payload as ProgressEventPayloads['addOutputFiles'];
        this.addOutputFiles(p.streamId, p.filesByRound);
        return;
      }
      case 'updateMissingOutputs': {
        const p = payload as ProgressEventPayloads['updateMissingOutputs'];
        this.updateMissingOutputs(p.streamId, p.filesByRound);
        return;
      }
      case 'updateCompileFailures': {
        const p = payload as ProgressEventPayloads['updateCompileFailures'];
        this.updateCompileFailures(p.streamId, p.filesByRound);
        return;
      }
      case 'updateStreamUsage': {
        const p = payload as ProgressEventPayloads['updateStreamUsage'];
        void this.addUsage(p.streamId, p.storageKey, p.usage);
        return;
      }
      case 'updateTodos': {
        const p = payload as ProgressEventPayloads['updateTodos'];
        this.setTodos(p.streamId, p.todos);
        return;
      }
      case 'updatePlan': {
        const p = payload as ProgressEventPayloads['updatePlan'];
        this.setPlan(p.streamId, p.plan);
        return;
      }
      case 'setTaskState': {
        const p = payload as ProgressEventPayloads['setTaskState'];
        this.setTaskState(p.streamId, p.taskState, p.executionId);
        return;
      }
      case 'updateStreamDescription': {
        const p = payload as ProgressEventPayloads['updateStreamDescription'];
        this.setDescription(p.streamId, p.description);
        return;
      }
      case 'setParentStream': {
        const p = payload as ProgressEventPayloads['setParentStream'];
        this.setParentStream(p.childStreamId, p.parentStreamId);
        return;
      }
      default:
        return;
    }
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
    let next: Promise<void> = Promise.resolve();
    next = this.ensureSeeded(stream, version)
      .then(() => {
        if (this.streamVersion(stream) !== version) return;
        if (!this.seeded.has(stream)) {
          if (this.seedChains.get(stream) === next) {
            this.seedChains.delete(stream);
          }
          return;
        }
        apply();
      })
      .catch((err: unknown) => {
        if (!this.seeded.has(stream) && this.seedChains.get(stream) === next) {
          this.seedChains.delete(stream);
        }
        logger.warn(CHANNEL, `Deferred update failed for stream ${stream}`, {
          data: err,
        });
      });
    this.seedChains.set(stream, next);
    return next;
  }

  /** Read a stream's existing disk data into memory once. */
  private ensureSeeded(stream: StreamTabId, version: number): Promise<void> {
    const existing = this.seedChains.get(stream);
    if (existing) return existing;
    const seed = this.readSeed(stream, version);
    this.seedChains.set(stream, seed);
    return seed;
  }

  private async readSeed(stream: StreamTabId, version: number): Promise<void> {
    if (this.streamVersion(stream) !== version) return;
    if (this.seeded.has(stream)) return;
    const data = await readStreamData(this.kv(stream));
    if (this.streamVersion(stream) !== version) return;
    await this.applyStreamData(stream, data);
  }

  // ==========================================================================
  // Mutators (mirror the consolidated managers)
  // ==========================================================================

  private getOrCreate<V>(
    map: Map<StreamTabId, Map<number, V>>,
    key: StreamTabId,
  ): Map<number, V> {
    let inner = map.get(key);
    if (!inner) {
      inner = new Map();
      map.set(key, inner);
    }
    return inner;
  }

  private parseOutputFilesPatch(
    filesByRound: RoundIndexed<OutputFileInfo>,
  ): OutputFilesPatch {
    const patch: OutputFilesPatch = new Map();
    for (const [round, files] of Object.entries(filesByRound)) {
      const key = RoundKeySchema.safeParse(round);
      if (!key.success) continue;
      const normalized = OutputFileInfoListSchema.parse(
        Array.isArray(files) ? files : [],
      );
      patch.set(key.data, normalized.length === 0 ? null : normalized);
    }
    return patch;
  }

  private applyOutputFilesPatch(
    stream: StreamTabId,
    patch: OutputFilesPatch,
  ): Map<number, OutputFileInfo[]> {
    const rounds = this.getOrCreate(this.outputFiles, stream);
    for (const [round, files] of patch) {
      if (files === null) rounds.delete(round);
      else rounds.set(round, files);
    }
    return rounds;
  }

  private addOutputFilesOverlay(
    stream: StreamTabId,
    patch: OutputFilesPatch,
  ): void {
    if (patch.size === 0) return;
    const overlay =
      this.outputFileOverlays.get(stream) ??
      new Map<number, OutputFileInfo[] | null>();
    for (const [round, files] of patch) overlay.set(round, files);
    this.outputFileOverlays.set(stream, overlay);
  }

  private writeOutputFiles(stream: StreamTabId): void {
    this.write(
      stream,
      STREAM_DATA_KEYS.OUTPUT_FILES,
      mapToRecord(this.outputFiles.get(stream) ?? new Map()),
    );
  }

  private applyUsageDeltaMemory(
    stream: StreamTabId,
    storageKey: StorageKey,
    delta: TokenUsageStats,
  ): TokenUsageStats | undefined {
    const current =
      this.usage.get(stream) ?? new Map<string, TokenUsageStats>();
    if (isEmptyUsage(delta)) return current.get(storageKey);
    const existing = current.get(storageKey) ?? emptyUsageStats();
    const accumulated = sumUsageStats([existing, delta]);
    current.set(storageKey, accumulated);
    this.usage.set(stream, current);
    return accumulated;
  }

  private addUsageOverlay(
    stream: StreamTabId,
    storageKey: StorageKey,
    delta: TokenUsageStats,
  ): void {
    if (isEmptyUsage(delta)) return;
    const overlay =
      this.usageOverlays.get(stream) ?? new Map<StorageKey, TokenUsageStats>();
    overlay.set(
      storageKey,
      sumUsageStats([overlay.get(storageKey) ?? emptyUsageStats(), delta]),
    );
    this.usageOverlays.set(stream, overlay);
  }

  private writeUsage(stream: StreamTabId): void {
    this.write(
      stream,
      STREAM_DATA_KEYS.USAGE_STATS,
      mapToRecord(this.usage.get(stream) ?? new Map()),
    );
  }

  addOutputFiles(
    stream: StreamTabId,
    filesByRound: RoundIndexed<OutputFileInfo>,
  ): void {
    const patch = this.parseOutputFilesPatch(filesByRound);
    if (patch.size === 0) return;

    if (this.canMutateSynchronously(stream)) {
      this.applyOutputFilesPatch(stream, patch);
      this.writeOutputFiles(stream);
      return;
    }

    const version = this.streamVersion(stream);
    this.applyOutputFilesPatch(stream, patch);
    this.addOutputFilesOverlay(stream, patch);
    this.queueAfterSeed(stream, version, () => undefined);
  }

  updateMissingOutputs(
    stream: StreamTabId,
    filesByRound: RoundIndexed<string>,
  ): void {
    this.mutate(stream, () => {
      const rounds = this.getOrCreate(this.missingOutputs, stream);
      for (const [round, files] of Object.entries(filesByRound)) {
        const key = RoundKeySchema.safeParse(round);
        if (key.success) rounds.set(key.data, files);
      }
      this.write(stream, STREAM_DATA_KEYS.MISSING_OUTPUTS, mapToRecord(rounds));
    });
  }

  updateCompileFailures(
    stream: StreamTabId,
    filesByRound: RoundIndexed<CompileFailure>,
  ): void {
    this.mutate(stream, () => {
      const rounds = this.getOrCreate(this.compileFailures, stream);
      for (const [round, failures] of Object.entries(filesByRound)) {
        const key = RoundKeySchema.safeParse(round);
        if (!key.success) continue;
        const normalized = CompileFailureSchema.array().parse(
          Array.isArray(failures) ? failures : [],
        );
        if (normalized.length === 0) rounds.delete(key.data);
        else rounds.set(key.data, normalized);
      }
      this.write(
        stream,
        STREAM_DATA_KEYS.COMPILE_FAILURES,
        mapToRecord(rounds),
      );
    });
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
    if (this.canMutateSynchronously(stream)) {
      const accumulated = this.applyUsageDeltaMemory(stream, storageKey, delta);
      if (!isEmptyUsage(delta)) this.writeUsage(stream);
      return accumulated;
    }

    const version = this.streamVersion(stream);
    this.applyUsageDeltaMemory(stream, storageKey, delta);
    this.addUsageOverlay(stream, storageKey, delta);
    return this.queueAfterSeed(stream, version, () => undefined).then(() => {
      if (this.streamVersion(stream) !== version || !this.seeded.has(stream)) {
        return undefined;
      }
      return this.usage.get(stream)?.get(storageKey);
    });
  }

  // ==========================================================================
  // Read accessors over in-memory accumulated state (replace manager getters)
  // ==========================================================================

  getOutputFiles(stream: StreamTabId): Map<number, OutputFileInfo[]> {
    return new Map(this.outputFiles.get(stream) ?? []);
  }

  getMissingOutputs(stream: StreamTabId): Map<number, string[]> {
    return new Map(this.missingOutputs.get(stream) ?? []);
  }

  getCompileFailures(stream: StreamTabId): Map<number, CompileFailure[]> {
    return new Map(this.compileFailures.get(stream) ?? []);
  }

  getRunUsage(stream: StreamTabId): Map<string, TokenUsageStats> {
    return new Map(this.usage.get(stream) ?? []);
  }

  /** Flattened set of known output-file paths for a stream. */
  getKnownFilePaths(
    stream: StreamTabId,
    options: { workspaceOnly?: boolean } = {},
  ): Set<string> {
    const paths = new Set<string>();
    const rounds = this.outputFiles.get(stream);
    if (!rounds) return paths;
    const workspaceOnly = options.workspaceOnly ?? false;
    for (const infos of rounds.values()) {
      for (const info of infos) {
        if (!workspaceOnly || info.location.kind === 'workspace') {
          paths.add(info.location.absolutePath);
        }
      }
    }
    return paths;
  }

  /** Clear the missing-outputs marker for a stream (memory + disk). */
  clearMissingOutputs(stream: StreamTabId): void {
    this.mutate(stream, () => {
      if (!this.missingOutputs.delete(stream)) return;
      this.write(stream, STREAM_DATA_KEYS.MISSING_OUTPUTS, {});
    });
  }

  // ==========================================================================
  // Lifecycle (replace manager evict/evictAll)
  // ==========================================================================

  /** Every stream id with any in-memory accumulator/overlay state. */
  private allKnownStreams(): Set<StreamTabId> {
    return new Set<StreamTabId>([
      ...this.outputFiles.keys(),
      ...this.missingOutputs.keys(),
      ...this.compileFailures.keys(),
      ...this.usage.keys(),
      ...this.workPlan.keys(),
      ...this.meta.keys(),
      ...this.runDescriptors.keys(),
      ...this.runConfigs.keys(),
      ...this.seeded,
      ...this.seedChains.keys(),
      ...this.outputFileOverlays.keys(),
      ...this.usageOverlays.keys(),
      ...this.kvCache.keys(),
    ]);
  }

  /** Drop a stream's in-memory state. Disk cleanup is the caller's job. */
  evict(stream: StreamTabId): void {
    this.bumpStreamVersion(stream);
    this.outputFiles.delete(stream);
    this.missingOutputs.delete(stream);
    this.compileFailures.delete(stream);
    this.usage.delete(stream);
    this.workPlan.delete(stream);
    this.meta.delete(stream);
    this.runDescriptors.delete(stream);
    this.runConfigs.delete(stream);
    this.seeded.delete(stream);
    this.seedChains.delete(stream);
    this.metaOverlays.delete(stream);
    this.outputFileOverlays.delete(stream);
    this.usageOverlays.delete(stream);
    this.kvCache.delete(stream);
    for (const key of [...this.pendingWrites.keys()]) {
      if (key.startsWith(`${stream}::`)) this.pendingWrites.delete(key);
    }
  }

  evictAll(): void {
    for (const stream of this.allKnownStreams()) this.bumpStreamVersion(stream);
    this.outputFiles.clear();
    this.missingOutputs.clear();
    this.compileFailures.clear();
    this.usage.clear();
    this.workPlan.clear();
    this.meta.clear();
    this.runDescriptors.clear();
    this.runConfigs.clear();
    this.seeded.clear();
    this.seedChains.clear();
    this.metaOverlays.clear();
    this.outputFileOverlays.clear();
    this.usageOverlays.clear();
    this.kvCache.clear();
    this.pendingWrites.clear();
  }

  /** Delete a stream's on-disk sidecar directory + in-memory state. */
  async deleteStream(stream: StreamTabId): Promise<void> {
    const pending = this.cancelPendingWritesForStream(stream);
    this.evict(stream);
    await Promise.all(pending);
    await this.kv(stream).deleteDir();
  }

  /** Delete the entire `streamData/` tree + all in-memory state. */
  async deleteAll(): Promise<void> {
    const pending = [...this.pendingWrites.values()];
    this.evictAll();
    await Promise.all(pending);
    await new KVStore(STREAM_DATA_DIR).deleteDir();
  }

  setTodos(stream: StreamTabId, todos: TodoItem[]): void {
    this.mutate(stream, () => {
      const next = { ...this.getWorkPlan(stream), todos };
      this.workPlan.set(stream, next);
      this.writeWorkPlan(stream, next);
    });
  }

  setPlan(stream: StreamTabId, plan: Plan | null): void {
    this.mutate(stream, () => {
      const next = {
        ...this.getWorkPlan(stream),
        plan,
        planSummary: plan ? planSummaryLine(plan.objective) : null,
      };
      this.workPlan.set(stream, next);
      this.writeWorkPlan(stream, next);
    });
  }

  getWorkPlan(stream: StreamTabId): WorkPlanSnapshot {
    return this.workPlan.get(stream) ?? EMPTY_WORK_PLAN;
  }

  private patchMetaMemory(
    stream: StreamTabId,
    patch: Partial<StreamTabMeta>,
  ): StreamTabMeta {
    const next: StreamTabMeta = {
      ...(this.meta.get(stream) ?? {}),
      ...patch,
      schemaVersion: RUN_DESCRIPTOR_SCHEMA_VERSION,
    };
    this.meta.set(stream, next);
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
    this.metaOverlays.add(stream);
    const applied = this.mutate(stream, () => {
      this.writeMeta(stream, this.patchMetaMemory(stream, patch));
      return true;
    });
    if (applied) this.metaOverlays.delete(stream);
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
    this.runConfigs.set(stream, config);
    const descriptor = executionId
      ? descriptorFromConfig(stream, executionId, config)
      : undefined;
    if (descriptor) this.runDescriptors.set(stream, descriptor);
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
    const config = this.runConfigs.get(stream);
    return config ? agentConfigToTaskState(config) : undefined;
  }

  getRunDescriptor(stream: StreamTabId): RunDescriptor | undefined {
    return this.runDescriptors.get(stream);
  }

  getRunConfig(stream: StreamTabId): AgentConfig | undefined {
    return this.runConfigs.get(stream);
  }

  getExecutionId(stream: StreamTabId): ExecutionId | undefined {
    // executionId is validated to a real ExecutionId at the single disk-read
    // entry (`readMeta`), so no cast/re-validation is needed here.
    return this.meta.get(stream)?.executionId;
  }

  /** Streams with persisted sidecars under `streamData/`. */
  async listPersistedStreams(): Promise<StreamTabId[]> {
    const entries = await this.readPersistedStreamDirs();
    return entries
      .filter(([, type]) => isDirectory(type))
      .map(([encoded]) => decodeStreamId(encoded))
      .filter((stream): stream is StreamTabId => stream !== undefined);
  }

  /** Execution id recorded in a stream sidecar, without seeding memory. */
  async readPersistedExecutionId(
    stream: StreamTabId,
  ): Promise<ExecutionId | undefined> {
    const meta = (await readStreamData(this.kv(stream))).meta;
    return meta?.runDescriptor?.executionId ?? meta?.executionId;
  }

  getParentStreamId(stream: StreamTabId): StreamTabId | undefined {
    return this.meta.get(stream)?.parentStreamId;
  }

  getDescription(stream: StreamTabId): string | undefined {
    return this.meta.get(stream)?.description;
  }

  /** Read-only view of stream→executionId for waiting-stream detection. */
  getExecutionIdMap(): ReadonlyMap<StreamTabId, ExecutionId> {
    const map = new Map<StreamTabId, ExecutionId>();
    for (const [stream, meta] of this.meta) {
      if (meta.executionId) map.set(stream, meta.executionId);
    }
    return map;
  }

  /** Stream IDs that still have execution sidecar state. */
  getTaskStateStreams(): Set<StreamTabId> {
    return new Set(this.runConfigs.keys());
  }

  /**
   * Workflow stream IDs whose taskState's agentConfig matches `match`. Used by
   * command-palette pack/clean to clear missing-output markers across every tab
   * that surfaced markers for the cleaned files. Both sides are canonicalized
   * (agent source prefixes stripped, paths normalized to forward slashes).
   */
  findWorkflowStreamsMatching(match: WorkflowStreamMatch): StreamTabId[] {
    const wantAgent = getCleanAgentName(match.agent);
    const wantFile = match.inputFile.replaceAll('\\', '/');
    const wantOutputFiles = normalizeOutputFiles(match.outputFiles);
    const result: StreamTabId[] = [];
    for (const [stream, cfg] of this.runConfigs) {
      if (cfg.agentCategory !== 'workflow') continue;
      const cfgPrimaryInput = (cfg.inputFiles[0] ?? '').replaceAll('\\', '/');
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
    const chainKey = `${stream}::${key}`;
    const version = this.streamVersion(stream);
    const prev = this.pendingWrites.get(chainKey) ?? Promise.resolve();
    // Best-effort: a failed sidecar write must not break the chain, but it is
    // logged so silent data loss (disk full, permission denied) is diagnosable.
    const next = prev
      .then(() => {
        // Eviction guard: `evict()`/`deleteStream()` drop this chain key. A
        // write queued before that must NOT fire afterward, or a late `kv()`
        // would re-create the `streamData/{id}/` dir `deleteDir()` just removed.
        if (!this.pendingWrites.has(chainKey)) return;
        if (this.streamVersion(stream) !== version) return;
        return this.kv(stream).write(key, value);
      })
      .catch((err: unknown) =>
        logger.warn(
          CHANNEL,
          `Failed to persist ${key}.json for stream ${stream}; sidecar may be stale.`,
          { data: err },
        ),
      );
    this.pendingWrites.set(chainKey, next);
  }

  private async flushWritesForStream(stream: StreamTabId): Promise<void> {
    const prefix = `${stream}::`;
    await Promise.all(
      [...this.pendingWrites]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, pending]) => pending),
    );
  }

  private cancelPendingWritesForStream(stream: StreamTabId): Promise<void>[] {
    const prefix = `${stream}::`;
    const pending: Promise<void>[] = [];
    for (const [key, write] of this.pendingWrites) {
      if (!key.startsWith(prefix)) continue;
      pending.push(write);
      this.pendingWrites.delete(key);
    }
    return pending;
  }

  /** Await deferred (seed-gated) mutations, then all in-flight writes. */
  async flush(): Promise<void> {
    await Promise.all(this.seedChains.values());
    await Promise.all(this.pendingWrites.values());
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
    const seedChain = this.seedChains.get(streamId);
    if (seedChain) {
      await seedChain;
    }
    if (this.seeded.has(streamId)) {
      return this.snapshotFromMemory(streamId);
    }
    return assembleSnapshot(streamId, await readStreamData(this.kv(streamId)));
  }

  /** Assemble the snapshot from already-hydrated in-memory accumulators. */
  private snapshotFromMemory(streamId: StreamTabId): StreamSnapshot {
    return assembleSnapshot(streamId, {
      meta: this.meta.get(streamId),
      outputFiles: this.outputFiles.get(streamId) ?? new Map(),
      missingOutputs: this.missingOutputs.get(streamId) ?? new Map(),
      compileFailures: this.compileFailures.get(streamId) ?? new Map(),
      usage: this.usage.get(streamId) ?? new Map(),
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
  ): Promise<Map<number, OutputFileInfo[]>> {
    const seedChain = this.seedChains.get(streamId);
    if (seedChain) {
      await seedChain;
    }
    if (this.seeded.has(streamId)) {
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
    for (const stream of this.allKnownStreams()) {
      if (!keep.has(stream)) this.evict(stream);
    }
  }

  private refreshSeed(stream: StreamTabId): Promise<void> {
    const version = this.streamVersion(stream);
    this.seeded.delete(stream);
    const prev = this.seedChains.get(stream) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (this.streamVersion(stream) !== version) return;
      await this.flushWritesForStream(stream);
      if (this.streamVersion(stream) !== version) return;
      this.kvCache.delete(stream);
      const data = await readStreamData(this.kv(stream));
      if (this.streamVersion(stream) !== version) return;
      await this.applyStreamData(stream, data);
    });
    this.seedChains.set(stream, next);
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
    const executionId = meta.runDescriptor?.executionId ?? meta.executionId;
    let descriptor = meta.runDescriptor;
    if (meta.runDescriptor) {
      descriptor = meta.runDescriptor;
    }

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
    const metaOverlay = this.metaOverlays.has(stream)
      ? this.meta.get(stream)
      : undefined;
    const runConfigOverlay =
      metaOverlay !== undefined ? this.runConfigs.get(stream) : undefined;
    const runDescriptorOverlay =
      metaOverlay !== undefined ? this.runDescriptors.get(stream) : undefined;
    const outputFileOverlay = this.outputFileOverlays.get(stream);
    const usageOverlay = this.usageOverlays.get(stream);
    const sidecarsToWrite = new Set(data.legacyKeys);
    this.outputFiles.set(stream, data.outputFiles);
    this.missingOutputs.set(stream, data.missingOutputs);
    this.compileFailures.set(stream, data.compileFailures);
    this.usage.set(
      stream,
      new Map([...data.usage].filter(([, v]) => !isEmptyUsage(v))),
    );
    this.workPlan.set(stream, data.workPlan);
    this.runDescriptors.delete(stream);
    this.runConfigs.delete(stream);
    let meta = metaOverlay
      ? { ...(data.meta ?? {}), ...metaOverlay }
      : data.meta;
    let hydrated: HydratedRunState = {};
    if (meta) {
      this.meta.set(stream, meta);
      hydrated = await this.hydrateRunStateFromMeta(stream, meta);
    } else {
      this.meta.delete(stream);
    }
    const latestMetaOverlay = this.metaOverlays.has(stream)
      ? this.meta.get(stream)
      : undefined;
    if (latestMetaOverlay) {
      meta = { ...(data.meta ?? {}), ...latestMetaOverlay };
      this.meta.set(stream, meta);
    }
    const latestRunConfigOverlay =
      latestMetaOverlay !== undefined ? this.runConfigs.get(stream) : undefined;
    const latestRunDescriptorOverlay =
      latestMetaOverlay !== undefined
        ? this.runDescriptors.get(stream)
        : undefined;
    const runConfig =
      latestRunConfigOverlay ?? runConfigOverlay ?? hydrated.config;
    const executionId = meta?.runDescriptor?.executionId ?? meta?.executionId;
    const runDescriptor =
      latestRunDescriptorOverlay ??
      runDescriptorOverlay ??
      hydrated.descriptor ??
      (runConfig && executionId
        ? descriptorFromConfig(stream, executionId, runConfig)
        : undefined);
    if (runConfig) this.runConfigs.set(stream, runConfig);
    if (runDescriptor) {
      this.runDescriptors.set(stream, runDescriptor);
    }
    this.metaOverlays.delete(stream);
    if (outputFileOverlay) {
      this.applyOutputFilesPatch(stream, outputFileOverlay);
      sidecarsToWrite.add(STREAM_DATA_KEYS.OUTPUT_FILES);
      this.outputFileOverlays.delete(stream);
    }
    if (usageOverlay) {
      for (const [storageKey, delta] of usageOverlay) {
        this.applyUsageDeltaMemory(stream, storageKey, delta);
      }
      sidecarsToWrite.add(STREAM_DATA_KEYS.USAGE_STATS);
      this.usageOverlays.delete(stream);
    }
    this.seeded.add(stream);
    this.writeMergedSidecars(stream, sidecarsToWrite);
  }

  /** Persist sidecars from merged memory after seeding and overlays converge. */
  private writeMergedSidecars(
    stream: StreamTabId,
    keys: Iterable<string>,
  ): void {
    for (const key of keys) {
      switch (key) {
        case STREAM_DATA_KEYS.OUTPUT_FILES:
          if (this.outputFiles.has(stream)) this.writeOutputFiles(stream);
          break;
        case STREAM_DATA_KEYS.USAGE_STATS:
          if (this.usage.has(stream)) this.writeUsage(stream);
          break;
        case STREAM_DATA_KEYS.MISSING_OUTPUTS: {
          const map = this.missingOutputs.get(stream);
          if (map) this.write(stream, key, mapToRecord(map));
          break;
        }
        case STREAM_DATA_KEYS.COMPILE_FAILURES: {
          const map = this.compileFailures.get(stream);
          if (map) this.write(stream, key, mapToRecord(map));
          break;
        }
      }
    }
  }

  /**
   * One-time backfill for streams with an executionId but no description in
   * meta.json: read it from ExecutionMeta and persist so future loads skip the
   * extra I/O. (Ported from StreamMetaManager.)
   */
  private async backfillDescriptionsFromExecutionMeta(): Promise<void> {
    for (const [streamId, meta] of [...this.meta]) {
      if (!meta.executionId || meta.description) continue;
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
