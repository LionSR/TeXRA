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
  type TaskState,
} from '@agent/core/execution/TaskState';
import { KVStore } from '@common/storage/KVStore';
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
  StreamSnapshotSchema,
  sumUsageStats,
  TokenUsageStatsParsingSchema,
  UsageDataSchema,
  WorkPlanSnapshotSchema,
  type CompileFailure,
  type ExecutionId,
  type OutputFileInfo,
  type Plan,
  type StorageKey,
  type StreamSnapshot,
  type StreamTabId,
  type TodoItem,
  type TokenUsageStats,
} from '@shared/schemas';

import { STREAM_DATA_KEYS, streamDataDir } from './streamDataPaths';

// ============================================================================
// In-memory shapes (mirror the managers being consolidated)
// ============================================================================

interface WorkPlanState {
  todos: TodoItem[];
  plan: Plan | null;
  planSummary: string | null;
}

interface MetaState {
  taskState?: TaskState;
  executionId?: ExecutionId;
  parentStreamId?: StreamTabId;
  description?: string;
}

/** Minimal on-disk meta shape (mirrors the extension's StreamTabMetaSchema). */
interface MetaFile {
  activeRunId?: string | null;
  parentStreamId?: string;
  executionId?: string;
  taskState?: unknown;
  description?: string;
}

/** Serialize a Map to a plain string-keyed Record for JSON persistence. */
function mapToRecord<K extends string | number, V>(
  map: Map<K, V>,
): Record<string, V> {
  return Object.fromEntries(Array.from(map, ([k, v]) => [String(k), v]));
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
  private readonly workPlan = new Map<StreamTabId, WorkPlanState>();
  private readonly meta = new Map<StreamTabId, MetaState>();

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
        ({ streamId, executionId, taskState }) => {
          this.patchMeta(streamId, { taskState });
          if (executionId) this.patchMeta(streamId, { executionId });
        },
        options,
      ),
      bus.on(
        'updateStreamDescription',
        ({ streamId, description }) =>
          this.patchMeta(streamId, { description }),
        options,
      ),
      bus.on(
        'setParentStream',
        ({ childStreamId, parentStreamId }) =>
          this.patchMeta(childStreamId, {
            parentStreamId: parentStreamId ?? undefined,
          }),
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

  /** Accumulate usage per run (mirrors UsageStatsManager.setRunUsage). */
  addUsage(
    stream: StreamTabId,
    storageKey: StorageKey,
    usage: TokenUsageStats,
  ): void {
    const delta = TokenUsageStatsParsingSchema.parse(usage);
    if (isEmptyUsage(delta)) return;
    const current =
      this.usage.get(stream) ?? new Map<string, TokenUsageStats>();
    const existing = current.get(storageKey) ?? emptyUsageStats();
    current.set(storageKey, sumUsageStats([existing, delta]));
    this.usage.set(stream, current);
    this.write(stream, STREAM_DATA_KEYS.USAGE_STATS, mapToRecord(current));
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

  private getWorkPlan(stream: StreamTabId): WorkPlanState {
    return (
      this.workPlan.get(stream) ?? { todos: [], plan: null, planSummary: null }
    );
  }

  private patchMeta(stream: StreamTabId, patch: Partial<MetaState>): void {
    const next = { ...(this.meta.get(stream) ?? {}), ...patch };
    this.meta.set(stream, next);
    const file: MetaFile = {
      ...(next.taskState && { taskState: next.taskState }),
      ...(next.executionId && { executionId: next.executionId }),
      ...(next.parentStreamId && { parentStreamId: next.parentStreamId }),
      ...(next.description && { description: next.description }),
    };
    this.write(stream, STREAM_DATA_KEYS.META, file);
  }

  // ==========================================================================
  // Writes — serialized per (stream, category), evict-safe
  // ==========================================================================

  private writeWorkPlan(stream: StreamTabId, plan: WorkPlanState): void {
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
    const next = prev
      .then(() => this.kv(stream).write(key, value))
      .catch(() => {});
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
      if (error instanceof SyntaxError) return undefined; // corrupt = missing
      throw error;
    }
  }

  /**
   * Reassemble the durable display snapshot for a stream from disk. Returns an
   * empty (but valid) snapshot when no sidecar exists yet. Liveness fields stay
   * at their defaults — callers layer log-derived + clamped-live state on top.
   */
  async read(streamId: StreamTabId): Promise<StreamSnapshot> {
    const kv = this.kv(streamId);
    const metaRaw = (await this.tryRead(kv, STREAM_DATA_KEYS.META)) as
      | MetaFile
      | undefined;
    const activeRunId = metaRaw?.activeRunId ?? undefined;

    const flatten = async <T>(
      key: string,
      schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
    ): Promise<T | undefined> => {
      const raw = await this.tryRead(kv, key);
      if (raw === undefined) return undefined;
      const migrated = isLegacyNested(raw)
        ? flattenLegacyRuns(raw, activeRunId)
        : raw;
      const parsed = schema.safeParse(migrated);
      return parsed.success ? parsed.data : undefined;
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
    const usage =
      usageRaw === undefined
        ? undefined
        : (UsageDataSchema.safeParse(usageRaw).data as
            | Map<string, TokenUsageStats>
            | undefined);

    const workPlanRaw = await this.tryRead(kv, STREAM_DATA_KEYS.WORK_PLAN);
    const workPlan = workPlanRaw
      ? WorkPlanSnapshotSchema.parse(workPlanRaw)
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

  /**
   * Seed in-memory accumulators from disk for resumed streams so subsequent
   * usage deltas accumulate on top of prior runs. Call before {@link subscribe}.
   */
  async load(streamIds: readonly StreamTabId[]): Promise<void> {
    for (const streamId of streamIds) {
      const snap = await this.read(streamId);
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
    }
  }

  /** Returns the resolved task state for a resumed stream, if persisted. */
  async readTaskState(streamId: StreamTabId): Promise<TaskState | undefined> {
    const metaRaw = (await this.tryRead(
      this.kv(streamId),
      STREAM_DATA_KEYS.META,
    )) as MetaFile | undefined;
    if (!metaRaw?.taskState) return undefined;
    const parsed = TaskStateSchema.safeParse(metaRaw.taskState);
    return parsed.success ? (parsed.data as TaskState) : undefined;
  }
}
