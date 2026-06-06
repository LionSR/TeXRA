/**
 * Host-agnostic, bus-driven per-stream sidecar persistence.
 *
 * One store, shared by the CLI TUI, VS Code extension, and Electron desktop
 * app, that is the SINGLE writer of `streamData/{id}/*` and the reader that
 * reassembles a {@link StreamSnapshot} for resume. It subscribes to the shared
 * {@link ProgressEventBus} and persists the same field-scoped files the
 * extension already writes (so all three hosts produce identical on-disk data),
 * plus the one new `workPlan.json` giving todos/plan a durable home.
 *
 * It consolidates the accumulation logic previously split across the extension's
 * `OutputFilesManager` / `UsageStatsManager` / `StreamMetaManager`, talking to
 * `KVStore` directly via the shared `streamDataDir()` layout. Writes are
 * serialized per (stream, category) so concurrent deltas never interleave.
 *
 * Liveness (active children, RUNNING status) is deliberately NOT persisted —
 * `read()` returns durable display state only; hosts clamp liveness on hydrate.
 */

import {
  TaskStateSchema,
  isToolUseTaskState,
  isWorkflowTaskState,
  type TaskState,
} from '@agent/core/execution/TaskState';
import { getCleanAgentName } from '@agent/index';
import { getExecutionStore } from '@agent/storage';
import { KVStore } from '@common/storage/KVStore';
import * as logger from '@logger/logUtils';
import type { ProgressEventBusLike } from '@eventBus/ProgressEventBus';
import {
  CompileFailureSchema,
  emptyUsageStats,
  isEmptyUsage,
  OutputFileInfoListSchema,
  PersistedWorkPlanSchema,
  RoundKeySchema,
  sumUsageStats,
  TokenUsageStatsParsingSchema,
  type CompileFailure,
  type ExecutionId,
  type OutputFileInfo,
  type Plan,
  type StorageKey,
  type StreamSnapshot,
  type StreamTabId,
  type StreamTabMeta,
  type TodoItem,
  type TokenUsageStats,
  type WorkPlanSnapshot,
} from '@shared/schemas';

import {
  STREAM_DATA_DIR,
  STREAM_DATA_KEYS,
  streamDataDir,
} from './streamDataPaths';
import {
  assembleSnapshot,
  mapToRecord,
  readStreamData,
  type StreamData,
} from './streamSnapshotRead';

const CHANNEL = 'StreamSnapshotStore';

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
  /** Typed task states (parsed once) backing the tool-use/workflow queries. */
  private readonly taskStates = new Map<StreamTabId, TaskState>();

  // -- Per (stream, category) serialized write chains -----------------------
  private readonly pendingWrites = new Map<string, Promise<void>>();

  // -- Lazy seeding: a stream's existing disk data is read into memory BEFORE
  // the first bus-driven mutation so an accumulate/merge can't overwrite (erase)
  // unloaded disk data. `seeded` = streams already in memory (via load or here);
  // `seedChains` serializes seed-then-mutate per stream.
  private readonly seeded = new Set<StreamTabId>();
  private readonly seedChains = new Map<StreamTabId, Promise<void>>();

  private readonly kvCache = new Map<StreamTabId, KVStore>();

  private kv(streamId: StreamTabId): KVStore {
    let store = this.kvCache.get(streamId);
    if (!store) {
      store = new KVStore(streamDataDir(streamId));
      this.kvCache.set(streamId, store);
    }
    return store;
  }

  // ==========================================================================
  // Bus subscription — the single write path
  // ==========================================================================

  /**
   * Subscribe to the progress bus and persist durable per-stream state. Each
   * mutation is gated on the stream being seeded from disk first (see
   * {@link applySeeded}) so a bus-driven accumulate can never erase unloaded
   * disk data. Returns a disposer.
   */
  subscribe(
    bus: ProgressEventBusLike,
    options?: { signal?: AbortSignal },
  ): () => void {
    const offs: Array<() => void> = [
      bus.on(
        'addOutputFiles',
        ({ streamId, filesByRound }) =>
          this.applySeeded(streamId, () =>
            this.addOutputFiles(streamId, filesByRound),
          ),
        options,
      ),
      bus.on(
        'updateMissingOutputs',
        ({ streamId, filesByRound }) =>
          this.applySeeded(streamId, () =>
            this.updateMissingOutputs(streamId, filesByRound),
          ),
        options,
      ),
      bus.on(
        'updateCompileFailures',
        ({ streamId, filesByRound }) =>
          this.applySeeded(streamId, () =>
            this.updateCompileFailures(streamId, filesByRound),
          ),
        options,
      ),
      bus.on(
        'updateStreamUsage',
        ({ streamId, storageKey, usage }) =>
          this.applySeeded(streamId, () =>
            this.addUsage(streamId, storageKey, usage),
          ),
        options,
      ),
      bus.on(
        'updateTodos',
        ({ streamId, todos }) =>
          this.applySeeded(streamId, () => this.setTodos(streamId, todos)),
        options,
      ),
      bus.on(
        'updatePlan',
        ({ streamId, plan }) =>
          this.applySeeded(streamId, () => this.setPlan(streamId, plan)),
        options,
      ),
      bus.on(
        'setTaskState',
        ({ streamId, executionId, taskState }) =>
          this.applySeeded(streamId, () =>
            this.setTaskState(streamId, taskState, executionId),
          ),
        options,
      ),
      bus.on(
        'updateStreamDescription',
        ({ streamId, description }) =>
          this.applySeeded(streamId, () =>
            this.setDescription(streamId, description),
          ),
        options,
      ),
      bus.on(
        'setParentStream',
        ({ childStreamId, parentStreamId }) =>
          this.applySeeded(childStreamId, () =>
            this.setParentStream(childStreamId, parentStreamId),
          ),
        options,
      ),
    ];

    return () => {
      for (const off of offs) off();
    };
  }

  /** Run `apply` after the stream is seeded from disk, serialized per stream. */
  private applySeeded(stream: StreamTabId, apply: () => void): void {
    const prev = this.seedChains.get(stream) ?? this.ensureSeeded(stream);
    const next = prev.then(apply).catch((err: unknown) =>
      logger.warn(CHANNEL, `Deferred update failed for stream ${stream}`, {
        data: err,
      }),
    );
    this.seedChains.set(stream, next);
  }

  /** Read a stream's existing disk data into memory once (no-op if loaded). */
  private async ensureSeeded(stream: StreamTabId): Promise<void> {
    if (this.seeded.has(stream)) return;
    this.seeded.add(stream);
    this.applyStreamData(stream, await readStreamData(this.kv(stream)));
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

  addOutputFiles(
    stream: StreamTabId,
    filesByRound: { [key: number]: OutputFileInfo[] },
  ): void {
    const rounds = this.getOrCreate(this.outputFiles, stream);
    for (const [round, files] of Object.entries(filesByRound)) {
      const key = RoundKeySchema.safeParse(round);
      if (!key.success) continue;
      const normalized = OutputFileInfoListSchema.parse(
        Array.isArray(files) ? files : [],
      );
      if (normalized.length === 0) rounds.delete(key.data);
      else rounds.set(key.data, normalized);
    }
    this.write(stream, STREAM_DATA_KEYS.OUTPUT_FILES, mapToRecord(rounds));
  }

  updateMissingOutputs(
    stream: StreamTabId,
    filesByRound: { [key: number]: string[] },
  ): void {
    const rounds = this.getOrCreate(this.missingOutputs, stream);
    for (const [round, files] of Object.entries(filesByRound)) {
      const key = RoundKeySchema.safeParse(round);
      if (key.success) rounds.set(key.data, files);
    }
    this.write(stream, STREAM_DATA_KEYS.MISSING_OUTPUTS, mapToRecord(rounds));
  }

  updateCompileFailures(
    stream: StreamTabId,
    filesByRound: { [key: number]: CompileFailure[] },
  ): void {
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
    this.write(stream, STREAM_DATA_KEYS.COMPILE_FAILURES, mapToRecord(rounds));
  }

  /**
   * Accumulate usage per run (mirrors UsageStatsManager.setRunUsage). Returns
   * the accumulated value for the run so callers can forward it to the UI.
   */
  addUsage(
    stream: StreamTabId,
    storageKey: StorageKey,
    usage: TokenUsageStats,
  ): TokenUsageStats | undefined {
    const delta = TokenUsageStatsParsingSchema.parse(usage);
    const current =
      this.usage.get(stream) ?? new Map<string, TokenUsageStats>();
    if (isEmptyUsage(delta)) return current.get(storageKey);
    const existing = current.get(storageKey) ?? emptyUsageStats();
    const accumulated = sumUsageStats([existing, delta]);
    current.set(storageKey, accumulated);
    this.usage.set(stream, current);
    this.write(stream, STREAM_DATA_KEYS.USAGE_STATS, mapToRecord(current));
    return accumulated;
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
    if (!this.missingOutputs.delete(stream)) return;
    this.write(stream, STREAM_DATA_KEYS.MISSING_OUTPUTS, {});
  }

  // ==========================================================================
  // Lifecycle (replace manager evict/evictAll)
  // ==========================================================================

  /** Drop a stream's in-memory state. Disk cleanup is the caller's job. */
  evict(stream: StreamTabId): void {
    this.outputFiles.delete(stream);
    this.missingOutputs.delete(stream);
    this.compileFailures.delete(stream);
    this.usage.delete(stream);
    this.workPlan.delete(stream);
    this.meta.delete(stream);
    this.taskStates.delete(stream);
    this.seeded.delete(stream);
    this.seedChains.delete(stream);
    this.kvCache.delete(stream);
    for (const key of [...this.pendingWrites.keys()]) {
      if (key.startsWith(`${stream}::`)) this.pendingWrites.delete(key);
    }
  }

  evictAll(): void {
    this.outputFiles.clear();
    this.missingOutputs.clear();
    this.compileFailures.clear();
    this.usage.clear();
    this.workPlan.clear();
    this.meta.clear();
    this.taskStates.clear();
    this.seeded.clear();
    this.seedChains.clear();
    this.kvCache.clear();
    this.pendingWrites.clear();
  }

  /** Delete a stream's on-disk sidecar directory + in-memory state. */
  async deleteStream(stream: StreamTabId): Promise<void> {
    await this.kv(stream).deleteDir();
    this.evict(stream);
  }

  /** Delete the entire `streamData/` tree + all in-memory state. */
  async deleteAll(): Promise<void> {
    await new KVStore(STREAM_DATA_DIR).deleteDir();
    this.evictAll();
  }

  setTodos(stream: StreamTabId, todos: TodoItem[]): void {
    const next = { ...this.getWorkPlan(stream), todos };
    this.workPlan.set(stream, next);
    this.writeWorkPlan(stream, next);
  }

  setPlan(stream: StreamTabId, plan: Plan | null): void {
    const next = {
      ...this.getWorkPlan(stream),
      plan,
      planSummary: plan?.summary ?? null,
    };
    this.workPlan.set(stream, next);
    this.writeWorkPlan(stream, next);
  }

  getWorkPlan(stream: StreamTabId): WorkPlanSnapshot {
    return (
      this.workPlan.get(stream) ?? { todos: [], plan: null, planSummary: null }
    );
  }

  private patchMeta(stream: StreamTabId, patch: Partial<StreamTabMeta>): void {
    const next: StreamTabMeta = { ...(this.meta.get(stream) ?? {}), ...patch };
    this.meta.set(stream, next);
    // activeRunId is legacy and never re-written.
    const file: StreamTabMeta = {
      ...(next.taskState !== undefined && { taskState: next.taskState }),
      ...(next.executionId && { executionId: next.executionId }),
      ...(next.parentStreamId && { parentStreamId: next.parentStreamId }),
      ...(next.description && { description: next.description }),
    };
    this.write(stream, STREAM_DATA_KEYS.META, file);
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
    this.taskStates.set(stream, taskState);
    this.patchMeta(
      stream,
      executionId ? { taskState, executionId } : { taskState },
    );
  }

  setExecutionId(stream: StreamTabId, executionId: ExecutionId): void {
    this.patchMeta(stream, { executionId });
  }

  setParentStream(
    child: StreamTabId,
    parent: StreamTabId | null | undefined,
  ): void {
    this.patchMeta(child, { parentStreamId: parent ?? undefined });
  }

  setDescription(stream: StreamTabId, description: string): void {
    this.patchMeta(stream, { description });
  }

  getTaskState(stream: StreamTabId): TaskState | undefined {
    return this.taskStates.get(stream);
  }

  getExecutionId(stream: StreamTabId): ExecutionId | undefined {
    return this.meta.get(stream)?.executionId as ExecutionId | undefined;
  }

  getParentStreamId(stream: StreamTabId): StreamTabId | undefined {
    return this.meta.get(stream)?.parentStreamId as StreamTabId | undefined;
  }

  getDescription(stream: StreamTabId): string | undefined {
    return this.meta.get(stream)?.description;
  }

  /** Read-only view of stream→executionId for waiting-stream detection. */
  getExecutionIdMap(): ReadonlyMap<StreamTabId, ExecutionId> {
    const map = new Map<StreamTabId, ExecutionId>();
    for (const [stream, meta] of this.meta) {
      if (meta.executionId) map.set(stream, meta.executionId as ExecutionId);
    }
    return map;
  }

  /** Stream IDs with active tool-use sessions. */
  getActiveToolUseStreams(): Set<StreamTabId> {
    return new Set(
      [...this.taskStates]
        .filter(([, state]) => isToolUseTaskState(state))
        .map(([stream]) => stream),
    );
  }

  /**
   * Workflow stream IDs whose taskState's agentConfig matches `match`. Used by
   * command-palette pack/clean to clear missing-output markers across every tab
   * that surfaced markers for the cleaned files. Both sides are canonicalized
   * (agent source prefixes stripped, paths normalized to forward slashes).
   */
  findWorkflowStreamsMatching(match: {
    agent: string;
    model: string;
    inputFile: string;
    outputFiles?: readonly string[];
  }): StreamTabId[] {
    const wantAgent = getCleanAgentName(match.agent);
    const wantFile = match.inputFile.replaceAll('\\', '/');
    const wantOutputFiles = normalizeOutputFiles(match.outputFiles);
    const result: StreamTabId[] = [];
    for (const [stream, state] of this.taskStates) {
      if (!isWorkflowTaskState(state)) continue;
      const cfg = state.agentConfig;
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
    const prev = this.pendingWrites.get(chainKey) ?? Promise.resolve();
    // Best-effort: a failed sidecar write must not break the chain, but it is
    // logged so silent data loss (disk full, permission denied) is diagnosable.
    const next = prev
      .then(() => this.kv(stream).write(key, value))
      .catch((err: unknown) =>
        logger.warn(
          CHANNEL,
          `Failed to persist ${key}.json for stream ${stream}; sidecar may be stale.`,
          { data: err },
        ),
      );
    this.pendingWrites.set(chainKey, next);
  }

  /** Await deferred (seed-gated) mutations, then all in-flight writes. */
  async flush(): Promise<void> {
    await Promise.all(this.seedChains.values());
    await Promise.all(this.pendingWrites.values());
  }

  // ==========================================================================
  // Read / load — disk reads delegate to the pure `streamSnapshotRead` module
  // ==========================================================================

  /** Reassemble the durable display snapshot for a stream from disk. */
  async read(streamId: StreamTabId): Promise<StreamSnapshot> {
    return assembleSnapshot(streamId, await readStreamData(this.kv(streamId)));
  }

  /** A stream's output files straight from disk (round → files). */
  async readOutputFiles(
    streamId: StreamTabId,
  ): Promise<Map<number, OutputFileInfo[]>> {
    return (await readStreamData(this.kv(streamId))).outputFiles;
  }

  /**
   * Seed in-memory accumulators from disk so subsequent usage deltas accumulate
   * on top of prior runs (and bus mutations can't erase unloaded data). Streams
   * not passed here are seeded lazily on their first bus event.
   */
  async load(streamIds: readonly StreamTabId[]): Promise<void> {
    for (const streamId of streamIds) {
      this.applyStreamData(streamId, await readStreamData(this.kv(streamId)));
    }
    await this.backfillDescriptionsFromExecutionMeta();
  }

  /** Seed the in-memory accumulators for one stream + migrate legacy once. */
  private applyStreamData(stream: StreamTabId, data: StreamData): void {
    this.outputFiles.set(stream, data.outputFiles);
    this.missingOutputs.set(stream, data.missingOutputs);
    this.compileFailures.set(stream, data.compileFailures);
    this.usage.set(
      stream,
      new Map([...data.usage].filter(([, v]) => !isEmptyUsage(v))),
    );
    this.workPlan.set(stream, data.workPlan);
    if (data.meta) {
      this.meta.set(stream, data.meta);
      if (data.meta.taskState !== undefined) {
        const parsed = TaskStateSchema.safeParse(data.meta.taskState);
        if (parsed.success) {
          this.taskStates.set(stream, parsed.data as TaskState);
        }
      }
    }
    this.seeded.add(stream);
    this.persistLegacyFlattened(stream, data);
  }

  /** Rewrite any legacy-nested sidecar file to its flattened form (once). */
  private persistLegacyFlattened(stream: StreamTabId, data: StreamData): void {
    const byKey = new Map<string, Map<number, unknown>>([
      [STREAM_DATA_KEYS.OUTPUT_FILES, data.outputFiles as Map<number, unknown>],
      [
        STREAM_DATA_KEYS.MISSING_OUTPUTS,
        data.missingOutputs as Map<number, unknown>,
      ],
      [
        STREAM_DATA_KEYS.COMPILE_FAILURES,
        data.compileFailures as Map<number, unknown>,
      ],
    ]);
    for (const key of data.legacyKeys) {
      const map = byKey.get(key);
      if (map) this.write(stream, key, mapToRecord(map));
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
        const execMeta = await getExecutionStore(
          meta.executionId as ExecutionId,
        ).readMeta();
        if (execMeta?.description) {
          this.setDescription(streamId, execMeta.description);
        }
      } catch {
        // Best-effort; a missing/corrupt execution store just skips backfill.
      }
    }
  }
}
