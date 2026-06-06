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

import { z } from 'zod';

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
  CompileFailuresDataSchema,
  CompileFailureSchema,
  emptyUsageStats,
  isLegacyNested,
  flattenLegacyRuns,
  isEmptyUsage,
  MissingOutputsDataSchema,
  OutputFileInfoListSchema,
  OutputFilesDataSchema,
  PersistedWorkPlanSchema,
  RoundKeySchema,
  StreamTabMetaSchema,
  StreamSnapshotSchema,
  sumUsageStats,
  TokenUsageStatsParsingSchema,
  UsageDataSchema,
  type CompileFailure,
  type ExecutionId,
  type OutputFileInfo,
  type Plan,
  type StorageKey,
  type StreamTabMeta,
  type StreamSnapshot,
  type StreamTabId,
  type TodoItem,
  type TokenUsageStats,
  type WorkPlanSnapshot,
} from '@shared/schemas';

import {
  STREAM_DATA_DIR,
  STREAM_DATA_KEYS,
  streamDataDir,
} from './streamDataPaths';

const CHANNEL = 'StreamSnapshotStore';

/** Serialize a Map to a plain string-keyed Record for JSON persistence. */
function mapToRecord<K extends string | number, V>(
  map: Map<K, V>,
): Record<string, V> {
  return Object.fromEntries(Array.from(map, ([k, v]) => [String(k), v]));
}

/** Inverse of {@link mapToRecord} for round-keyed records. */
function recordToRoundMap<V>(record: Record<string, V>): Map<number, V> {
  const map = new Map<number, V>();
  for (const [key, value] of Object.entries(record)) {
    map.set(Number(key), value);
  }
  return map;
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
   * Subscribe to the progress bus and persist durable per-stream state.
   * Returns a disposer. Call {@link load} for any resumed streams BEFORE
   * subscribing so usage continues accumulating on top of prior runs.
   */
  subscribe(
    bus: ProgressEventBusLike,
    options?: { signal?: AbortSignal },
  ): () => void {
    const offs: Array<() => void> = [
      bus.on(
        'addOutputFiles',
        ({ streamId, filesByRound }) =>
          this.addOutputFiles(streamId, filesByRound),
        options,
      ),
      bus.on(
        'updateMissingOutputs',
        ({ streamId, filesByRound }) =>
          this.updateMissingOutputs(streamId, filesByRound),
        options,
      ),
      bus.on(
        'updateCompileFailures',
        ({ streamId, filesByRound }) =>
          this.updateCompileFailures(streamId, filesByRound),
        options,
      ),
      bus.on(
        'updateStreamUsage',
        ({ streamId, storageKey, usage }) =>
          this.addUsage(streamId, storageKey, usage),
        options,
      ),
      bus.on(
        'updateTodos',
        ({ streamId, todos }) => this.setTodos(streamId, todos),
        options,
      ),
      bus.on(
        'updatePlan',
        ({ streamId, plan }) => this.setPlan(streamId, plan),
        options,
      ),
      bus.on(
        'setTaskState',
        ({ streamId, executionId, taskState }) =>
          this.setTaskState(streamId, taskState, executionId),
        options,
      ),
      bus.on(
        'updateStreamDescription',
        ({ streamId, description }) =>
          this.setDescription(streamId, description),
        options,
      ),
      bus.on(
        'setParentStream',
        ({ childStreamId, parentStreamId }) =>
          this.setParentStream(childStreamId, parentStreamId),
        options,
      ),
    ];

    return () => {
      for (const off of offs) off();
    };
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

  /** Await all in-flight writes (call before process exit). */
  async flush(): Promise<void> {
    await Promise.all(this.pendingWrites.values());
  }

  // ==========================================================================
  // Read — reassemble a durable StreamSnapshot for resume
  // ==========================================================================

  private async tryRead(
    kv: KVStore,
    key: string,
  ): Promise<unknown | undefined> {
    try {
      return await kv.read(key);
    } catch (error) {
      // Corrupt/truncated JSON (crash mid-write) is treated as missing — the
      // next write replaces it — but logged so it isn't silently swallowed.
      if (error instanceof SyntaxError) {
        logger.warn(
          CHANNEL,
          `Discarding unreadable ${key}.json; treating as missing.`,
          { data: error },
        );
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Reassemble the durable display snapshot for a stream from disk. Returns an
   * empty (but valid) snapshot when no sidecar exists yet. Liveness fields stay
   * at their defaults — callers layer log-derived + clamped-live state on top.
   */
  private async readMetaFile(kv: KVStore): Promise<StreamTabMeta | undefined> {
    const raw = await this.tryRead(kv, STREAM_DATA_KEYS.META);
    if (raw === undefined) return undefined;
    const parsed = StreamTabMetaSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  async read(streamId: StreamTabId): Promise<StreamSnapshot> {
    const kv = this.kv(streamId);
    const metaRaw = await this.readMetaFile(kv);
    const activeRunId = metaRaw?.activeRunId ?? undefined;

    const flatten = async <T extends Map<number, unknown[]>>(
      key: string,
      schema: z.ZodType<T>,
    ): Promise<T | undefined> => {
      const raw = await this.tryRead(kv, key);
      if (raw === undefined) return undefined;
      const wasLegacy = isLegacyNested(raw);
      const migrated = wasLegacy ? flattenLegacyRuns(raw, activeRunId) : raw;
      const parsed = schema.safeParse(migrated);
      if (!parsed.success) return undefined;
      // Migrate the pre-#3061 nested `{runId:{round}}` shape to flat ONCE, at
      // this read entry, by persisting the flattened form — so the conversion
      // never runs again for this file (no repetitive resolve on every read).
      if (wasLegacy) this.write(streamId, key, mapToRecord(parsed.data));
      return parsed.data;
    };

    const [outputFiles, missingOutputs, compileFailures] = await Promise.all([
      flatten<Map<number, OutputFileInfo[]>>(
        STREAM_DATA_KEYS.OUTPUT_FILES,
        OutputFilesDataSchema,
      ),
      flatten<Map<number, string[]>>(
        STREAM_DATA_KEYS.MISSING_OUTPUTS,
        MissingOutputsDataSchema,
      ),
      flatten<Map<number, CompileFailure[]>>(
        STREAM_DATA_KEYS.COMPILE_FAILURES,
        CompileFailuresDataSchema,
      ),
    ]);

    const usageRaw = await this.tryRead(kv, STREAM_DATA_KEYS.USAGE_STATS);
    const usageParsed =
      usageRaw === undefined ? undefined : UsageDataSchema.safeParse(usageRaw);
    const usage = usageParsed?.success ? usageParsed.data : undefined;

    // safeParse + per-field `.catch` (PersistedWorkPlanSchema) so a corrupt-but-
    // valid-JSON workPlan.json degrades gracefully instead of throwing and
    // aborting the whole read()/load(), matching every other category here.
    const workPlanRaw = await this.tryRead(kv, STREAM_DATA_KEYS.WORK_PLAN);
    const parsedWorkPlan = workPlanRaw
      ? PersistedWorkPlanSchema.safeParse(workPlanRaw)
      : undefined;
    const workPlan =
      parsedWorkPlan?.success === true
        ? parsedWorkPlan.data
        : { todos: [], plan: null, planSummary: null };

    return StreamSnapshotSchema.parse({
      streamId,
      todos: workPlan.todos,
      plan: workPlan.plan,
      planSummary: workPlan.planSummary,
      outputFilesByRound: outputFiles ? mapToRecord(outputFiles) : {},
      missingOutputsByRound: missingOutputs ? mapToRecord(missingOutputs) : {},
      compileFailuresByRound: compileFailures
        ? mapToRecord(compileFailures)
        : {},
      runUsage: usage ? mapToRecord(usage) : {},
      executionId: metaRaw?.executionId,
      parentStreamId: metaRaw?.parentStreamId,
      description: metaRaw?.description,
    });
  }

  /** Read a stream's output files straight from disk (round → files). */
  async readOutputFiles(
    streamId: StreamTabId,
  ): Promise<Map<number, OutputFileInfo[]>> {
    const snap = await this.read(streamId);
    return recordToRoundMap(snap.outputFilesByRound);
  }

  /**
   * Seed in-memory accumulators from disk for resumed streams so subsequent
   * usage deltas accumulate on top of prior runs. Call before {@link subscribe}.
   */
  async load(streamIds: readonly StreamTabId[]): Promise<void> {
    for (const streamId of streamIds) {
      const snap = await this.read(streamId);
      this.outputFiles.set(streamId, recordToRoundMap(snap.outputFilesByRound));
      this.missingOutputs.set(
        streamId,
        recordToRoundMap(snap.missingOutputsByRound),
      );
      this.compileFailures.set(
        streamId,
        recordToRoundMap(snap.compileFailuresByRound),
      );
      this.usage.set(
        streamId,
        new Map(
          Object.entries(snap.runUsage).filter(([, v]) => !isEmptyUsage(v)),
        ),
      );
      this.workPlan.set(streamId, {
        todos: snap.todos,
        plan: snap.plan,
        planSummary: snap.planSummary,
      });
      const meta = await this.readMetaFile(this.kv(streamId));
      if (meta) {
        this.meta.set(streamId, meta);
        if (meta.taskState !== undefined) {
          const parsed = TaskStateSchema.safeParse(meta.taskState);
          if (parsed.success) {
            this.taskStates.set(streamId, parsed.data as TaskState);
          }
        }
      }
    }
    await this.backfillDescriptionsFromExecutionMeta();
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

  /** Returns the resolved task state for a resumed stream, if persisted. */
  async readTaskState(streamId: StreamTabId): Promise<TaskState | undefined> {
    const metaRaw = await this.readMetaFile(this.kv(streamId));
    if (metaRaw?.taskState === undefined) return undefined;
    const parsed = TaskStateSchema.safeParse(metaRaw.taskState);
    return parsed.success ? (parsed.data as TaskState) : undefined;
  }
}
