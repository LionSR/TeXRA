import { getExecutionStore } from '@agent/storage';
import { normalizeRunId } from '@common/constants/runIds';
import { AgentLogger } from '@logger/AgentLogger';
import {
  TaskStateSchema,
  isToolUseTaskState,
  type TaskState,
} from '@logger/TaskState';
import { getStreamTabStore } from '@progressView/persistence/StreamTabStore';
import type { StreamTabMeta } from '@progressView/persistence/streamTabSchemas';
import type { ExecutionId, StorageKey, StreamTabId } from '@shared/schemas';

/**
 * Manages per-stream metadata with disk-backed persistence via meta.json.
 *
 * Owns: taskStates, executionIds, activeRunIds, parentStreamIds.
 * Disk writes happen per-stream on mutation. Disk deletion is owned by
 * ProgressViewState (via store.clear() / deleteAllStreamData()).
 */
export class StreamMetaManager {
  private taskStates = new Map<StreamTabId, TaskState>();
  private executionIds = new Map<StreamTabId, ExecutionId>();
  private activeRunIds = new Map<StreamTabId, StorageKey | null>();
  private parentStreamIds = new Map<StreamTabId, StreamTabId>();
  private descriptions = new Map<StreamTabId, string>();
  private loaded = false;
  private readonly logger: AgentLogger;
  private readonly pendingWrites = new Map<StreamTabId, Promise<void>>();

  constructor() {
    this.logger = new AgentLogger('StreamMetaManager');
  }

  // -- Task states ------------------------------------------------------------

  getTaskState(stream: StreamTabId): TaskState | undefined {
    return this.taskStates.get(stream);
  }

  /** Store task state and persist. Coordination side effects owned by caller. */
  setTaskState(stream: StreamTabId, taskState: TaskState): void {
    this.taskStates.set(stream, taskState);
    this.save(stream);
  }

  // -- Execution IDs ----------------------------------------------------------

  getExecutionId(stream: StreamTabId): ExecutionId | undefined {
    return this.executionIds.get(stream);
  }

  setExecutionId(stream: StreamTabId, executionId: ExecutionId): void {
    this.executionIds.set(stream, executionId);
    this.save(stream);
  }

  // -- Active run IDs ---------------------------------------------------------

  getActiveRunId(stream: StreamTabId): StorageKey | null {
    return this.activeRunIds.get(stream) ?? null;
  }

  setActiveRunId(stream: StreamTabId, runId: string | null): void {
    this.activeRunIds.set(stream, runId ? normalizeRunId(runId) : null);
    this.save(stream);
  }

  // -- Parent stream IDs ------------------------------------------------------

  getParentStreamId(stream: StreamTabId): StreamTabId | undefined {
    return this.parentStreamIds.get(stream);
  }

  setParentStream(child: StreamTabId, parent: StreamTabId): void {
    this.parentStreamIds.set(child, parent);
    this.save(child);
  }

  // -- Descriptions -----------------------------------------------------------

  getDescription(stream: StreamTabId): string | undefined {
    return this.descriptions.get(stream);
  }

  /** Store description in memory and persist to StreamTabMeta. */
  setDescription(stream: StreamTabId, description: string): void {
    this.descriptions.set(stream, description);
    this.save(stream);
  }

  // -- Queries ----------------------------------------------------------------

  /** Read-only view of stream→executionId mapping (for detectWaitingStreams). */
  getExecutionIdMap(): ReadonlyMap<StreamTabId, ExecutionId> {
    return this.executionIds;
  }

  /** Return stream IDs with active tool-use sessions. */
  getActiveToolUseStreams(): Set<StreamTabId> {
    const result = new Set<StreamTabId>();
    for (const [stream, state] of this.taskStates) {
      if (isToolUseTaskState(state)) result.add(stream);
    }
    return result;
  }

  // -- Lifecycle --------------------------------------------------------------

  /** Remove a stream from in-memory state. Disk cleanup owned by caller. */
  evict(stream: StreamTabId): void {
    this.taskStates.delete(stream);
    this.executionIds.delete(stream);
    this.activeRunIds.delete(stream);
    this.parentStreamIds.delete(stream);
    this.descriptions.delete(stream);
    this.pendingWrites.delete(stream);
  }

  /** Clear all in-memory state. Disk cleanup owned by caller. */
  evictAll(): void {
    this.taskStates.clear();
    this.executionIds.clear();
    this.activeRunIds.clear();
    this.parentStreamIds.clear();
    this.descriptions.clear();
    this.pendingWrites.clear();
  }

  /** Load metadata from disk-backed StreamTabStore for all known streams. */
  async load(streamIds: StreamTabId[]): Promise<void> {
    this.evictAll();

    const results = await Promise.all(
      streamIds.map(async (streamId) => {
        const store = getStreamTabStore(streamId);
        const meta = await store.readMeta();
        return { streamId, meta };
      }),
    );

    let loadedTasks = 0;
    let skippedTasks = 0;

    for (const { streamId, meta } of results) {
      if (!meta) continue;

      if (meta.taskState) {
        const result = TaskStateSchema.safeParse(meta.taskState);
        if (result.success) {
          this.taskStates.set(streamId, result.data as TaskState);
          loadedTasks++;
        } else {
          this.logger.warn(
            `Skipping invalid task state for stream ${streamId}: ${result.error.message}`,
          );
          skippedTasks++;
        }
      }

      if (meta.executionId) {
        this.executionIds.set(streamId, meta.executionId as ExecutionId);
      }

      if (meta.activeRunId) {
        this.activeRunIds.set(streamId, normalizeRunId(meta.activeRunId));
      }

      if (meta.parentStreamId) {
        this.parentStreamIds.set(streamId, meta.parentStreamId as StreamTabId);
      }

      if (meta.description) {
        this.descriptions.set(streamId, meta.description);
      }
    }

    // Backfill: streams with an executionId but no description in StreamTabMeta
    // may have descriptions in ExecutionMeta (written before descriptions were
    // persisted to StreamTabMeta). Fetch them once and persist so future loads
    // are fast.
    await this.backfillDescriptionsFromExecutionMeta();

    this.loaded = true;

    this.logger.info(
      `Loaded: ${loadedTasks} task states, ${skippedTasks} skipped, ${this.executionIds.size} execution IDs`,
    );
  }

  /**
   * One-time backfill for streams that have an executionId but no description
   * in StreamTabMeta. Reads from ExecutionMeta and persists to StreamTabMeta
   * so subsequent loads don't need this extra I/O.
   */
  private async backfillDescriptionsFromExecutionMeta(): Promise<void> {
    const missing = [...this.executionIds.entries()].filter(
      ([streamId]) => !this.descriptions.has(streamId),
    );
    if (missing.length === 0) return;

    const results = await Promise.all(
      missing.map(async ([streamId, executionId]) => {
        try {
          const meta = await getExecutionStore(executionId).readMeta();
          return { streamId, description: meta?.description };
        } catch {
          return { streamId, description: undefined };
        }
      }),
    );

    const backfilled: StreamTabId[] = [];
    for (const { streamId, description } of results) {
      if (description) {
        this.descriptions.set(streamId, description);
        backfilled.push(streamId);
      }
    }

    // Persist backfilled descriptions so future loads skip this I/O.
    // save() is gated on `this.loaded`, so write directly here.
    if (backfilled.length > 0) {
      await Promise.all(
        backfilled.map((streamId) => {
          const meta = this.buildMeta(streamId);
          return getStreamTabStore(streamId)
            .writeMeta(meta)
            .catch(() => {});
        }),
      );
      this.logger.info(
        `Backfilled ${backfilled.length} description(s) from ExecutionMeta`,
      );
    }
  }

  /** Await all pending disk writes. */
  async flush(): Promise<void> {
    await Promise.all(this.pendingWrites.values());
  }

  // -- Per-stream persistence -------------------------------------------------

  private save(stream: StreamTabId): void {
    if (!this.loaded) return;
    // Serialize writes per stream to avoid concurrent writes to the same meta.json.
    // Each new save chains after the previous pending write for that stream.
    const prev = this.pendingWrites.get(stream) ?? Promise.resolve();
    const next = prev.then(() => {
      // Skip write if the stream was evicted while this write was queued.
      // evict() deletes from pendingWrites, so absence means eviction.
      if (!this.pendingWrites.has(stream)) return;
      const meta = this.buildMeta(stream);
      const store = getStreamTabStore(stream);
      return store.writeMeta(meta);
    });
    this.pendingWrites.set(
      stream,
      next.catch(() => {}),
    );
  }

  private buildMeta(stream: StreamTabId): StreamTabMeta {
    const meta: StreamTabMeta = {};

    const taskState = this.taskStates.get(stream);
    if (taskState) meta.taskState = taskState;

    const executionId = this.executionIds.get(stream);
    if (executionId) meta.executionId = executionId;

    const activeRunId = this.activeRunIds.get(stream);
    if (activeRunId != null) meta.activeRunId = activeRunId;

    const parentStreamId = this.parentStreamIds.get(stream);
    if (parentStreamId) meta.parentStreamId = parentStreamId;

    const description = this.descriptions.get(stream);
    if (description) meta.description = description;

    return meta;
  }
}
