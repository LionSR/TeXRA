// Third-party imports
import PQueue from 'p-queue';

// Local imports
import {
  deleteExecution as deleteStoredExecution,
  listExecutionStreamReferences,
  type DeleteExecutionOptions,
  type DeleteExecutionResult,
  type ExecutionStreamReference,
} from '@agent/storage/executionListing';
import { waitForOwnedExecutionLeaseRelease } from '@agent/storage/executionLease';
import { createLog } from '@logger/logUtils';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import type { StreamLogStore, StreamSnapshotStore } from '@transcript';
import type { StagedStreamSnapshotDeletion } from '@transcript/StagedDeletionCoordinator';
import { canUseStreamDataDir } from '@transcript/streamDataPaths';
import { throwAggregated, unique } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('SessionStores');

type DeleteExecutionFn = (
  executionId: ExecutionId,
  options?: DeleteExecutionOptions,
) => Promise<DeleteExecutionResult>;
type ListExecutionStreamReferencesFn = () => Promise<
  ExecutionStreamReference[]
>;

interface GoalEntryStore {
  forget(stream: StreamTabId): Promise<void>;
  forgetMany(streams: readonly StreamTabId[]): Promise<void>;
}

export interface SessionStoresOptions {
  streamLogs: StreamLogStore;
  snapshots: StreamSnapshotStore;
  deleteExecution?: DeleteExecutionFn;
  listExecutionStreamReferences?: ListExecutionStreamReferencesFn;
  goalEntries?: GoalEntryStore;
  /** Runs after a canonical transcript stream is committed as deleted. */
  onCanonicalStreamDeleted?: (stream: StreamTabId) => void | Promise<void>;
  /** Projects parent-edge removals after their durable repair commits. */
  onChildrenDetached?: (
    parent: StreamTabId,
    children: readonly StreamTabId[],
  ) => void | Promise<void>;
}

export interface DeleteAllStreamsResult {
  readonly active: ReadonlySet<StreamTabId>;
  readonly failed: ReadonlySet<StreamTabId>;
}

export type DeleteStreamResult = 'deleted' | 'active' | 'failed';

/**
 * Result of removing an execution together with its adjacent stream state.
 * `streams-deleted` and `retained` separate the two failure shapes: whether
 * the adjacent cleanup had already committed when the removal failed, which
 * decides whether the stream may be reported as gone.
 */
type ExecutionDeletionOutcome =
  | { readonly kind: 'completed'; readonly result: DeleteExecutionResult }
  | { readonly kind: 'streams-deleted'; readonly error: unknown }
  | { readonly kind: 'retained'; readonly error: unknown };

/**
 * Coordinates the durable footprint for a progress stream.
 *
 * `StreamLogStore` and `StreamSnapshotStore` keep separate on-disk formats;
 * this class owns the lifecycle invariant across those formats plus the
 * execution directory they reference.
 */
export class SessionStores {
  private readonly streamLogs: StreamLogStore;
  private readonly snapshots: StreamSnapshotStore;
  private readonly deleteExecution: DeleteExecutionFn;
  private readonly listExecutionStreamReferences: ListExecutionStreamReferencesFn;
  private readonly goalEntries: GoalEntryStore | undefined;
  private readonly onCanonicalStreamDeleted:
    ((stream: StreamTabId) => void | Promise<void>) | undefined;
  private readonly onChildrenDetached:
    | ((
        parent: StreamTabId,
        children: readonly StreamTabId[],
      ) => void | Promise<void>)
    | undefined;
  private readonly pendingStreamDeletions = new Map<
    StreamTabId,
    Promise<DeleteStreamResult>
  >();
  private pendingDeleteAll: Promise<DeleteAllStreamsResult> | undefined;
  private readonly deletionQueue = new PQueue({ concurrency: 1 });

  constructor(options: SessionStoresOptions) {
    this.streamLogs = options.streamLogs;
    this.snapshots = options.snapshots;
    this.deleteExecution = options.deleteExecution ?? deleteStoredExecution;
    this.listExecutionStreamReferences =
      options.listExecutionStreamReferences ?? listExecutionStreamReferences;
    this.goalEntries = options.goalEntries;
    this.onCanonicalStreamDeleted = options.onCanonicalStreamDeleted;
    this.onChildrenDetached = options.onChildrenDetached;
  }

  async waitForOwnedExecutionRelease(stream: StreamTabId): Promise<void> {
    const executionId = await this.executionIdForStream(stream);
    if (executionId) await waitForOwnedExecutionLeaseRelease(executionId);
  }

  deleteStream(stream: StreamTabId): Promise<DeleteStreamResult> {
    return this.trackStreamDeletion(stream, () =>
      this.enqueueDeletion(() => this.deleteStreamAndNotify(stream)),
    );
  }

  deleteStreamAfterOwnedExecutionRelease(
    stream: StreamTabId,
  ): Promise<DeleteStreamResult> {
    return this.trackStreamDeletion(stream, async () => {
      // Track the whole wait so a presentation attaching during terminal
      // artifact persistence cannot replay a stream already marked removed.
      // If the ownership read fails here, report `failed` immediately rather
      // than enqueueing a second read that could decide the stream has no
      // execution and delete it.
      try {
        await this.waitForOwnedExecutionRelease(stream);
      } catch (error) {
        log.warn(
          `Stream ${stream} was retained because its execution ownership could not be read: ${toErrorMessage(error)}`,
          { data: error },
        );
        return 'failed';
      }
      return this.enqueueDeletion(() => this.deleteStreamAndNotify(stream));
    });
  }

  private trackStreamDeletion(
    stream: StreamTabId,
    start: () => Promise<DeleteStreamResult>,
  ): Promise<DeleteStreamResult> {
    const existing = this.pendingStreamDeletions.get(stream);
    if (existing) return existing;
    const pending = start();
    this.pendingStreamDeletions.set(stream, pending);
    const finish = (): void => this.finishStreamDeletion(stream, pending);
    void pending.then(finish, finish);
    return pending;
  }

  private async deleteStreamAndNotify(
    stream: StreamTabId,
  ): Promise<DeleteStreamResult> {
    const hadCanonicalStream = this.streamLogs.has(stream);
    const result = await this.deleteStreamOnce(stream);
    if (result === 'deleted' && hadCanonicalStream) {
      await this.notifyDeleted(stream);
    }
    return result;
  }

  async waitForPendingStreamDeletions(): Promise<void> {
    while (
      this.pendingStreamDeletions.size > 0 ||
      this.pendingDeleteAll !== undefined
    ) {
      await Promise.allSettled([
        ...this.pendingStreamDeletions.values(),
        ...(this.pendingDeleteAll ? [this.pendingDeleteAll] : []),
      ]);
    }
  }

  flushSnapshotsAfterStartedDeletions(): Promise<void> {
    // Serialize the flush after deletion work that has reached durable
    // storage, without waiting on pre-deletion lease barriers that this flush
    // may itself release.
    return this.enqueueDeletion(() => this.snapshots.flush());
  }

  private enqueueDeletion<T>(operation: () => Promise<T>): Promise<T> {
    return this.deletionQueue.add(operation);
  }

  private finishStreamDeletion(
    stream: StreamTabId,
    pending: Promise<DeleteStreamResult>,
  ): void {
    if (this.pendingStreamDeletions.get(stream) === pending) {
      this.pendingStreamDeletions.delete(stream);
    }
  }

  private async notifyDeleted(stream: StreamTabId): Promise<void> {
    if (!this.onCanonicalStreamDeleted) return;
    try {
      await this.onCanonicalStreamDeleted(stream);
    } catch (error) {
      log.warn(
        `Stream ${stream} was deleted, but canonical session cleanup was incomplete: ${toErrorMessage(error)}`,
        { data: error },
      );
    }
  }

  private async notifyChildrenDetached(
    stream: StreamTabId,
    children: readonly StreamTabId[],
  ): Promise<void> {
    if (!this.onChildrenDetached) return;
    try {
      await this.onChildrenDetached(stream, children);
    } catch (error) {
      log.warn(
        `Stream ${stream} was deleted, but child-detachment projection was incomplete: ${toErrorMessage(error)}`,
        { data: error },
      );
    }
  }

  /** Notify for streams that had a canonical transcript and were not retained. */
  private async notifyCanonicalDeletions(
    streams: readonly StreamTabId[],
    canonicalStreams: ReadonlySet<StreamTabId>,
    retained?: ReadonlySet<StreamTabId>,
  ): Promise<void> {
    await Promise.all(
      streams
        .filter(
          (stream) => canonicalStreams.has(stream) && !retained?.has(stream),
        )
        .map((stream) => this.notifyDeleted(stream)),
    );
  }

  private async deleteStreamOnce(
    stream: StreamTabId,
  ): Promise<DeleteStreamResult> {
    if (!canUseStreamDataDir(stream)) return 'deleted';

    let executionId: ExecutionId | undefined;
    try {
      executionId = await this.executionIdForStream(stream);
    } catch (error) {
      log.warn(
        `Stream ${stream} was retained because its execution ownership could not be read: ${toErrorMessage(error)}`,
        { data: error },
      );
      return 'failed';
    }

    if (!executionId) {
      try {
        await this.deleteAdjacentStreamState(stream);
      } catch (error) {
        log.warn(
          `Stream ${stream} was retained because cleanup was incomplete: ${toErrorMessage(error)}`,
          { data: error },
        );
        return 'failed';
      }
      return 'deleted';
    }

    const outcome = await this.deleteExecutionWithStreamState(executionId, () =>
      this.deleteAdjacentStreamState(stream),
    );
    switch (outcome.kind) {
      case 'completed':
        return outcome.result.status === 'active' ? 'active' : 'deleted';
      case 'streams-deleted':
        log.warn(
          `Stream ${stream} was deleted, but execution ${executionId} cleanup was incomplete: ${toErrorMessage(outcome.error)}`,
          { data: outcome.error },
        );
        return 'deleted';
      case 'retained':
        log.warn(
          `Stream ${stream} was retained because cleanup was incomplete: ${toErrorMessage(outcome.error)}`,
          { data: outcome.error },
        );
        return 'failed';
    }
  }

  /**
   * Remove an execution, running `cleanup` for its adjacent stream state under
   * the same inactive-lease guard, so every deletion path shares one owner of
   * the "did the stream state already commit?" invariant.
   */
  private async deleteExecutionWithStreamState(
    executionId: ExecutionId,
    cleanup: () => Promise<void>,
  ): Promise<ExecutionDeletionOutcome> {
    let cleanupCompleted = false;
    try {
      const result = await this.deleteExecution(executionId, {
        beforeDelete: async () => {
          await cleanup();
          cleanupCompleted = true;
        },
      });
      return { kind: 'completed', result };
    } catch (error) {
      return cleanupCompleted
        ? { kind: 'streams-deleted', error }
        : { kind: 'retained', error };
    }
  }

  /**
   * The stream→execution reverse edge. Live deletion paths resolve the current
   * execution from the resident snapshot record first: `run.start` updates the
   * in-memory record and the summary mirror synchronously, while the persisted
   * sidecar FK is written asynchronously and may still name the previous
   * execution until the run-end flush. For streams with no resident record the
   * persisted sidecar FK is authoritative (settled streams, #10518), then the
   * always-resident summary mirror for legacy streams without a persisted FK.
   * A stream with neither has no owned execution — name resemblance is never
   * ownership, so no suffix derivation exists.
   */
  private async executionIdForStream(
    stream: StreamTabId,
  ): Promise<ExecutionId | undefined> {
    return (
      this.snapshots.getRunMetadata(stream).executionId ??
      (await this.snapshots.readPersistedExecutionId(stream)) ??
      this.streamLogs.getSummaryMeta(stream)?.executionId
    );
  }

  private async reconcileStagedDeletions(
    liveStreams: ReadonlySet<StreamTabId>,
  ): Promise<void> {
    const reconciliation =
      await this.snapshots.reconcileStagedDeletions(liveStreams);
    if (
      reconciliation.restored.length > 0 ||
      reconciliation.pendingCleanup.length > 0 ||
      reconciliation.discarded.length > 0
    ) {
      log.info('Reconciled interrupted stream deletions', {
        data: reconciliation,
      });
    }
  }

  deleteAll(): Promise<DeleteAllStreamsResult> {
    if (this.pendingDeleteAll) return this.pendingDeleteAll;
    const pending = this.enqueueDeletion(() => this.deleteAllOnce());
    this.pendingDeleteAll = pending;
    const finish = (): void => this.finishDeleteAll(pending);
    void pending.then(finish, finish);
    return pending;
  }

  private finishDeleteAll(pending: Promise<DeleteAllStreamsResult>): void {
    if (this.pendingDeleteAll === pending) this.pendingDeleteAll = undefined;
  }

  private async deleteAllOnce(): Promise<DeleteAllStreamsResult> {
    await this.reconcileStagedDeletions(new Set(this.streamLogs.keys()));
    const [persistedStreams, stagedDeletions] = await Promise.all([
      this.snapshots.listPersistedStreams(),
      this.snapshots.listStagedDeletions(),
    ]);
    const snapshotStreams = unique([...persistedStreams, ...stagedDeletions]);
    const canonicalStreams = new Set(this.streamLogs.keys());
    const streamIds = unique([...snapshotStreams, ...canonicalStreams]);
    const executionIdsByStream = new Map(this.snapshots.getExecutionIdMap());
    const failed = new Set<StreamTabId>();
    const retainUnreadable = (stream: StreamTabId, error: unknown): void => {
      // Per-stream isolation: one unreadable ownership record retains that
      // stream instead of failing the whole bulk deletion before it starts.
      log.warn(
        `Stream ${stream} was retained because its execution ownership could not be read: ${toErrorMessage(error)}`,
        { data: error },
      );
      failed.add(stream);
    };
    for (const stream of snapshotStreams) {
      try {
        const executionId =
          await this.snapshots.readPersistedExecutionId(stream);
        if (executionId) executionIdsByStream.set(stream, executionId);
      } catch (error) {
        retainUnreadable(stream, error);
      }
    }

    const streamsByExecution = new Map<ExecutionId, StreamTabId[]>();
    const streamsWithoutExecution: StreamTabId[] = [];
    for (const stream of streamIds) {
      if (failed.has(stream)) continue;
      const executionId = executionIdsByStream.get(stream);
      if (!executionId) {
        streamsWithoutExecution.push(stream);
        continue;
      }
      const streams = streamsByExecution.get(executionId) ?? [];
      streams.push(stream);
      streamsByExecution.set(executionId, streams);
    }
    const active = new Set<StreamTabId>();
    await Promise.all(
      streamsWithoutExecution.map(async (stream) => {
        try {
          await this.deleteAdjacentStreamState(stream);
          if (canonicalStreams.has(stream)) await this.notifyDeleted(stream);
        } catch (error) {
          log.warn(
            `Failed to delete stream ${stream}: ${toErrorMessage(error)}`,
            { data: error },
          );
          failed.add(stream);
        }
      }),
    );
    await Promise.all(
      [...streamsByExecution].map(async ([executionId, streams]) => {
        let failedAdjacentStreams = new Set<StreamTabId>();
        const outcome = await this.deleteExecutionWithStreamState(
          executionId,
          async () => {
            const cleanup = await this.deleteAdjacentStreamStates(streams);
            failedAdjacentStreams = cleanup.failed;
            throwAggregated(
              cleanup.failures,
              'Multiple adjacent cleanups failed',
            );
          },
        );

        if (outcome.kind === 'completed') {
          if (outcome.result.status === 'active') {
            for (const stream of streams) active.add(stream);
          } else {
            await this.notifyCanonicalDeletions(streams, canonicalStreams);
          }
          return;
        }
        if (outcome.kind === 'streams-deleted') {
          log.warn(
            `Streams for execution ${executionId} were deleted, but execution cleanup was incomplete: ${toErrorMessage(outcome.error)}`,
            { data: outcome.error },
          );
          await this.notifyCanonicalDeletions(streams, canonicalStreams);
          return;
        }
        log.warn(
          `Failed to delete streams for execution ${executionId}: ${toErrorMessage(outcome.error)}`,
          { data: outcome.error },
        );
        const retainedStreams =
          failedAdjacentStreams.size > 0
            ? failedAdjacentStreams
            : streams.filter((stream) => this.streamLogs.has(stream));
        for (const stream of retainedStreams) failed.add(stream);
        if (failedAdjacentStreams.size > 0) {
          await this.notifyCanonicalDeletions(
            streams,
            canonicalStreams,
            failedAdjacentStreams,
          );
        }
      }),
    );
    return { active, failed };
  }

  /**
   * The startup sweep every process owner runs before presenting a rail: drop
   * leftover background shells, then persisted state no live stream refers to.
   *
   * One entry point so the order lives in one place. It matters: the ephemeral
   * sweep removes streams from the transcript index, and the orphan sweep reads
   * that index as its live set — running them the other way round would take
   * the shells' own sidecars for orphans on the next launch instead of this one.
   */
  async sweepLeftoverStreams(): Promise<void> {
    await this.sweepEphemeralStreams(new Set(this.streamLogs.keys()));
    const orphans = await this.sweepOrphanedStreams(
      new Set(this.streamLogs.keys()),
    );
    if (orphans.streams.length > 0 || orphans.executionIds.length > 0) {
      log.info(
        `Removed ${orphans.streams.length} orphaned stream sidecar(s) and ${orphans.executionIds.length} execution dir(s).`,
        { data: orphans },
      );
    }
  }

  /**
   * Delete background-shell streams a previous process left behind.
   *
   * A background shell is ephemeral by construction: `autoClose` drops its tab
   * the moment the command finalizes, and the command's output is already
   * delivered into the parent run's transcript. One still on disk means the
   * host exited mid-command or the deletion was refused — nothing can resume
   * it, so it is leftover state rather than history, and left alone it never
   * stops accumulating.
   *
   * No presentation can make this call: stream phases are in-memory only, so a
   * persisted shell hydrates with no status at all and no rail filter can key
   * off one.
   *
   * A shell still running holds its execution lease, so `deleteStream` answers
   * `'active'` and keeps it — the durable lease is the liveness authority here,
   * not an in-memory phase. The cost is that a shell whose host crashed inside
   * the lease's staleness window is retained (loudly) until the next launch.
   */
  private async sweepEphemeralStreams(
    liveStreams: ReadonlySet<StreamTabId>,
  ): Promise<StreamTabId[]> {
    const swept: StreamTabId[] = [];
    const retained: StreamTabId[] = [];
    for (const stream of liveStreams) {
      // Identity is the one authority on what a stream is: a background shell
      // persists `RunIdentity` `{ kind: 'process' }` in its summary meta
      // mirror. A summary without the mirror is treated as not-a-shell and
      // left alone until its next sidecar hydration backfills the meta.
      if (this.streamLogs.getSummaryMeta(stream)?.identity?.kind !== 'process')
        continue;
      // Awaited one at a time because `deletionQueue` already serializes every
      // deletion on this instance at concurrency 1: firing them together would
      // only queue them, trading readable sequencing for a burst of promises.
      // Per-stream failure isolation: one unreadable leftover must not abandon
      // the rest of the sweep, and must not fail the load that called it.
      try {
        if ((await this.deleteStream(stream)) === 'deleted') swept.push(stream);
        else retained.push(stream);
      } catch (error) {
        retained.push(stream);
        log.warn(
          `Failed to sweep leftover background shell ${stream}: ${toErrorMessage(error)}`,
          { data: error },
        );
      }
    }
    if (swept.length > 0) {
      log.info(`Swept ${swept.length} leftover background-shell stream(s).`);
    }
    if (retained.length > 0) {
      log.warn(
        `${retained.length} leftover background-shell stream(s) could not be swept and stay listed.`,
        { data: { retained } },
      );
    }
    return swept;
  }

  /**
   * Delete persisted sidecars and execution directories no live transcript
   * stream refers to.
   *
   * The live set is only authoritative when the transcript index itself is
   * persistent. A host running on an ephemeral store after a failed transcript
   * open sees an empty index, so sweeping would read that as "every persisted
   * stream is orphaned" and erase state a later healthy launch would restore.
   */
  async sweepOrphanedStreams(
    liveStreams: ReadonlySet<StreamTabId>,
  ): Promise<{ streams: StreamTabId[]; executionIds: ExecutionId[] }> {
    if (this.streamLogs.mode.kind !== 'persistent') {
      log.warn(
        `Skipped the orphaned-stream sweep: the transcript index is ${this.streamLogs.mode.kind} and cannot say which persisted streams are still live.`,
      );
      return { streams: [], executionIds: [] };
    }
    await this.reconcileStagedDeletions(liveStreams);
    const [persistedStreams, stagedDeletions] = await Promise.all([
      this.snapshots.listPersistedStreams(),
      this.snapshots.listStagedDeletions(),
    ]);
    const orphanedStreams = unique([
      ...persistedStreams,
      ...stagedDeletions,
    ]).filter((stream) => !liveStreams.has(stream));
    const sweptStreams: StreamTabId[] = [];
    const sweptExecutionIds: ExecutionId[] = [];

    await Promise.all(
      orphanedStreams.map(async (stream) => {
        try {
          const executionId =
            await this.snapshots.readPersistedExecutionId(stream);
          if (executionId) {
            const outcome = await this.deleteExecutionWithStreamState(
              executionId,
              () => this.deleteAdjacentStreamState(stream),
            );
            if (outcome.kind === 'streams-deleted') {
              sweptStreams.push(stream);
              log.warn(
                `Orphaned stream ${stream} was removed, but execution ${executionId} cleanup was incomplete.`,
                { data: outcome.error },
              );
              return;
            }
            if (outcome.kind === 'retained') {
              log.warn(
                `Skipping orphaned execution cleanup for ${executionId}; startup will continue.`,
                { data: outcome.error },
              );
              return;
            }
            if (outcome.result.status === 'active') return;
            if (outcome.result.status === 'deleted') {
              sweptExecutionIds.push(executionId);
            }
          } else {
            await this.deleteAdjacentStreamState(stream);
          }
          sweptStreams.push(stream);
        } catch (error) {
          log.warn(
            `Skipping orphaned stream cleanup for ${stream}; startup will continue.`,
            { data: error },
          );
        }
      }),
    );
    sweptExecutionIds.push(
      ...(await this.sweepOrphanedExecutions(liveStreams)),
    );
    return { streams: sweptStreams, executionIds: sweptExecutionIds };
  }

  /**
   * Sweep execution directories whose explicit metadata reference is absent
   * from the persistent transcript index. Metadata without a `streamId` and
   * unreadable metadata stay untouched: they do not establish ownership.
   */
  private async sweepOrphanedExecutions(
    liveStreams: ReadonlySet<StreamTabId>,
  ): Promise<ExecutionId[]> {
    let references;
    try {
      references = await this.listExecutionStreamReferences();
    } catch (error) {
      log.warn(
        `Skipping execution-side orphan cleanup; startup will continue: ${toErrorMessage(error)}`,
        { data: error },
      );
      return [];
    }

    const swept: ExecutionId[] = [];
    // Await each candidate so a large run history does not enqueue every
    // deletion promise at once; the shared queue is serialized regardless.
    for (const { executionId, streamId } of references) {
      if (liveStreams.has(streamId) || this.streamLogs.has(streamId)) continue;
      try {
        const result = await this.enqueueDeletion(async () => {
          // A stream can be registered by another host between this process's
          // scan and deletion. Only the durable transcript index may admit the
          // irreversible delete; this instance's cached summary is a prefilter.
          if (await this.streamLogs.hasAuthoritativeStream(streamId)) {
            return undefined;
          }
          return this.deleteExecution(executionId);
        });
        if (result?.status === 'deleted') swept.push(executionId);
      } catch (error) {
        log.warn(
          `Skipping orphaned execution cleanup for ${executionId}; startup will continue.`,
          { data: error },
        );
      }
    }
    return swept;
  }

  private async deleteAdjacentStreamState(stream: StreamTabId): Promise<void> {
    const snapshotDeletion = await this.snapshots.stageDeleteStream(
      stream,
      (children) => this.notifyChildrenDetached(stream, children),
    );
    try {
      // The transcript registry is the commit point for tab visibility.
      // Snapshot sidecars are only renamed before this, so a failure can roll
      // them back without reconstructing state from partial files.
      await this.streamLogs.delete(stream);
    } catch (error) {
      try {
        await snapshotDeletion.rollback();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Transcript and snapshot rollback failed for stream ${stream}`,
        );
      }
      throw error;
    }

    const cleanup = await Promise.allSettled([
      snapshotDeletion.commit(),
      this.goalEntries?.forget(stream),
    ]);
    for (const result of cleanup) {
      if (result.status === 'fulfilled') continue;
      log.warn(
        `Stream ${stream} was deleted, but auxiliary cleanup was incomplete: ${toErrorMessage(result.reason)}`,
        { data: result.reason },
      );
    }
  }

  private async deleteAdjacentStreamStates(
    streams: readonly StreamTabId[],
  ): Promise<{
    failed: Set<StreamTabId>;
    failures: unknown[];
  }> {
    const failed = new Set<StreamTabId>();
    const failures: unknown[] = [];
    const staged = new Map<StreamTabId, StagedStreamSnapshotDeletion>();
    await Promise.all(
      streams.map(async (stream) => {
        try {
          staged.set(
            stream,
            await this.snapshots.stageDeleteStream(stream, (children) =>
              this.notifyChildrenDetached(stream, children),
            ),
          );
        } catch (error) {
          failed.add(stream);
          failures.push(error);
        }
      }),
    );

    const transcriptResults = await Promise.all(
      streams
        .filter((stream) => !failed.has(stream))
        .map(async (stream) => {
          try {
            await this.streamLogs.delete(stream);
            return { stream, status: 'fulfilled' as const };
          } catch (error) {
            return { stream, status: 'rejected' as const, error };
          }
        }),
    );
    for (const result of transcriptResults) {
      if (result.status === 'fulfilled') continue;
      failed.add(result.stream);
      failures.push(result.error);
      try {
        await staged.get(result.stream)?.rollback();
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    }

    const committedStreams = streams.filter((stream) => !failed.has(stream));
    const cleanup = await Promise.allSettled([
      ...committedStreams.map((stream) => staged.get(stream)?.commit()),
      committedStreams.length > 0
        ? this.goalEntries?.forgetMany(committedStreams)
        : undefined,
    ]);
    for (const result of cleanup) {
      if (result.status === 'fulfilled') continue;
      log.warn(
        `Streams were deleted, but auxiliary cleanup was incomplete: ${toErrorMessage(result.reason)}`,
        { data: result.reason },
      );
    }
    return { failed, failures };
  }
}
