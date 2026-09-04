// Third-party imports
import PQueue from 'p-queue';

// Local imports
import { createLog } from '@logger/logUtils';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import type { StreamLogStore, StreamSnapshotStore } from '@transcript';
import { deleteTranscriptWithSnapshotRollback } from '@transcript/StagedDeletionCoordinator';
import { StreamDeletionSupersededError } from '@transcript/StreamLogStore';
import { canUseStreamDataDir } from '@transcript/streamDataPaths';
import { throwAggregated, unique } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  deleteExecution as deleteStoredExecution,
  listExecutionStreamReferences,
  type DeleteExecutionOptions,
  type DeleteExecutionResult,
  type ExecutionStreamReferenceListing,
  readExecutionStreamIndex,
} from './executionListing';

const log = createLog('SessionStores');

type DeleteExecutionFn = (
  executionId: ExecutionId,
  options?: DeleteExecutionOptions,
) => Promise<DeleteExecutionResult>;
type ListExecutionStreamReferencesFn =
  () => Promise<ExecutionStreamReferenceListing>;

interface GoalEntryStore {
  forget(stream: StreamTabId): Promise<void>;
}

/**
 * A per-stream map of per-incarnation values that prunes itself: deleting a
 * stream's last incarnation also removes the stream's now-empty inner map,
 * so `size` and `allValues` only ever see live entries. Used for
 * `pendingStreamDeletions`, which keys first by stream, then by incarnation,
 * and needs to prune-when-empty at every write.
 */
class IncarnationMap<K2, V> {
  private readonly byStream = new Map<StreamTabId, Map<K2, V>>();

  get size(): number {
    return this.byStream.size;
  }

  get(stream: StreamTabId, incarnation: K2): V | undefined {
    return this.byStream.get(stream)?.get(incarnation);
  }

  set(stream: StreamTabId, incarnation: K2, value: V): void {
    const byIncarnation = this.byStream.get(stream) ?? new Map<K2, V>();
    this.byStream.set(stream, byIncarnation);
    byIncarnation.set(incarnation, value);
  }

  delete(stream: StreamTabId, incarnation: K2): void {
    const byIncarnation = this.byStream.get(stream);
    if (!byIncarnation) return;
    byIncarnation.delete(incarnation);
    if (byIncarnation.size === 0) this.byStream.delete(stream);
  }

  allValues(): V[] {
    return [...this.byStream.values()].flatMap((byIncarnation) => [
      ...byIncarnation.values(),
    ]);
  }
}

/** The execution-lifecycle lane a stream deletion runs on as its own step. */
export interface ExecutionLifecycleLane {
  runExecutionStep<T>(executionId: string, step: () => Promise<T>): Promise<T>;
}

export interface SessionStoresOptions {
  streamLogs: StreamLogStore;
  snapshots: StreamSnapshotStore;
  /**
   * The session's per-execution lifecycle lanes. A deletion runs as a step on
   * the stream's execution lane, so it cannot run under a live or
   * still-disposing generation of that execution and no generation starts
   * until it has landed. Absent only for stores with no registry to serialize
   * against.
   */
  executions?: ExecutionLifecycleLane;
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
  /** Streams whose adjacent durable state this call actually deleted. */
  readonly deleted: ReadonlySet<StreamTabId>;
}

export type DeleteStreamResult = 'deleted' | 'active' | 'failed' | 'superseded';

/**
 * Result of removing an execution together with its adjacent stream state.
 * `streams-deleted` and `retained` separate the two failure shapes: whether
 * the adjacent cleanup had already committed when the removal failed, which
 * decides whether the stream may be reported as gone.
 */
type ExecutionDeletionOutcome =
  | { readonly kind: 'completed'; readonly result: DeleteExecutionResult }
  | { readonly kind: 'streams-deleted'; readonly error: unknown }
  | { readonly kind: 'retained'; readonly error: unknown }
  | { readonly kind: 'superseded' };

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
  private readonly executions: ExecutionLifecycleLane | undefined;
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
  /**
   * Single-flight per stream, then per incarnation. Process- and
   * presentation-owned removals use different guard functions, but the same
   * incarnation identifies the same deletion. A re-claimed identity's new
   * incarnation starts independently. `undefined` is the unkeyed slot.
   */
  private readonly pendingStreamDeletions = new IncarnationMap<
    number | undefined,
    Promise<DeleteStreamResult>
  >();
  private readonly streamDeletionClaims = new Map<StreamTabId, Set<symbol>>();
  private pendingDeleteAll: Promise<DeleteAllStreamsResult> | undefined;
  private readonly deletionQueue = new PQueue({ concurrency: 1 });

  constructor(options: SessionStoresOptions) {
    this.streamLogs = options.streamLogs;
    this.snapshots = options.snapshots;
    this.executions = options.executions;
    this.deleteExecution = options.deleteExecution ?? deleteStoredExecution;
    this.listExecutionStreamReferences =
      options.listExecutionStreamReferences ?? listExecutionStreamReferences;
    this.goalEntries = options.goalEntries;
    this.onCanonicalStreamDeleted = options.onCanonicalStreamDeleted;
    this.onChildrenDetached = options.onChildrenDetached;
  }

  /**
   * Claim presentation ownership before deletion preparation reaches its
   * first await. The process-level desktop fallback uses this synchronous
   * signal to distinguish a live projection from a genuinely headless run.
   */
  claimStreamDeletion(stream: StreamTabId): () => void {
    const claims = this.streamDeletionClaims.get(stream) ?? new Set<symbol>();
    this.streamDeletionClaims.set(stream, claims);
    const claim = Symbol(stream);
    claims.add(claim);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      claims.delete(claim);
      if (claims.size === 0) this.streamDeletionClaims.delete(stream);
    };
  }

  /**
   * Whether a live presentation currently owns this stream's removal.
   *
   * The desktop process store only decides whether to start a headless
   * fallback in the removal microtask. Any outstanding claim means that a
   * presentation already owns that decision, and claims are released when its
   * deletion settles or fails.
   */
  hasStreamDeletionClaim(stream: StreamTabId): boolean {
    return this.streamDeletionClaims.has(stream);
  }

  /**
   * Delete a stream as a lifecycle step of its execution's lane: the deletion
   * starts once every earlier step has returned and the live generation, if
   * any, has disposed, and no generation can start until it has landed. A
   * stream with no execution is deleted without a lane. The lane is taken
   * before the deletion queue, so a deletion waiting on a disposing generation
   * does not hold up the queue's other work (`deleteAll`, the snapshot flush).
   */
  deleteStream(
    stream: StreamTabId,
    options?: {
      readonly shouldDelete?: () => boolean;
      readonly expectedIncarnation?: number;
    },
  ): Promise<DeleteStreamResult> {
    return this.trackStreamDeletion(
      stream,
      options?.expectedIncarnation,
      async () => {
        if (!this.hasResidentStreamState(stream)) {
          // Nothing this instance knows about is left to delete: some other
          // owner — the leftover sweep, another host — already committed this
          // stream's deletion. Every presentation that projects the resulting
          // `removeStream` fact routes back through here, and without this the
          // repeat costs a staged-deletion rescan plus a full walk of the
          // executions directory, once per shell per presentation, to delete
          // nothing. Report the deletion as committed so the caller still does
          // its presentation-only removal.
          if (options?.shouldDelete?.() === false) return 'superseded';
          // The goal entry is keyed by stream alone and outlives both stores,
          // so it is the one durable footprint a never-registered stream can
          // still own. Forgetting it is a single in-memory key check when it
          // holds nothing.
          await this.forgetGoalEntry(stream);
          return 'deleted';
        }
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
        const deletion = (): Promise<DeleteStreamResult> =>
          this.enqueueDeletion(async () => {
            // Staged residue from a crash makes `stageDeleteStream` throw
            // until it is reconciled, and the sweep that used to reconcile
            // everything at bring-up now runs after the UI is up — a user (or
            // the sweep itself) can reach this stream first. Recover just this
            // stream's residue here, on the deletion queue, so it is ordered
            // against THIS instance's other deletions. Mutual exclusion with
            // the sweep's unscoped pass is not this queue's to give — the
            // sweep builds its own `SessionStores` — and belongs to the
            // coordinator both reconciles share (`StagedDeletionCoordinator`,
            // which serializes them). The reconciliation stays logged.
            await this.reconcileStagedDeletions(
              new Set(this.streamLogs.keys()),
              new Set([stream]),
            );
            return this.deleteStreamAndNotify(
              stream,
              executionId,
              options?.shouldDelete,
            );
          });
        if (!executionId || !this.executions) return deletion();
        try {
          return await this.executions.runExecutionStep(executionId, deletion);
        } catch (error) {
          // `deleteStreamAndNotify` reports through its result, so a throw is
          // the lane refusing the step: the session disposed, or a storage-root
          // change holds the lifecycle.
          log.warn(
            `Stream ${stream} was retained because its execution lane refused the deletion: ${toErrorMessage(error)}`,
            { data: error },
          );
          return 'failed';
        }
      },
    );
  }

  /**
   * Delete only the transcript and snapshot state for an execution that an
   * external history owner is already deleting. Keeping this operation here
   * preserves the session's child, goal, status, and resource projections
   * without recursively deleting the execution a second time.
   */
  deleteAdjacentStreamState(stream: StreamTabId): Promise<void> {
    return this.enqueueDeletion(async () => {
      // Same recovery as `deleteStream`: a history delete can reach a stream
      // with staged residue before the deferred sweep has reconciled it.
      await this.reconcileStagedDeletions(
        new Set(this.streamLogs.keys()),
        new Set([stream]),
      );
      const hadCanonicalStream = this.streamLogs.has(stream);
      await this.deleteStreamSidecars(stream);
      if (hadCanonicalStream) await this.notifyDeleted(stream);
    });
  }

  private trackStreamDeletion(
    stream: StreamTabId,
    expectedIncarnation: number | undefined,
    start: () => Promise<DeleteStreamResult>,
  ): Promise<DeleteStreamResult> {
    const existing = this.pendingStreamDeletions.get(
      stream,
      expectedIncarnation,
    );
    if (existing) return existing;
    const pending = start();
    this.pendingStreamDeletions.set(stream, expectedIncarnation, pending);
    const finish = (): void =>
      this.finishStreamDeletion(stream, expectedIncarnation, pending);
    void pending.then(finish, finish);
    return pending;
  }

  private async deleteStreamAndNotify(
    stream: StreamTabId,
    executionId: ExecutionId | undefined,
    shouldDelete?: () => boolean,
  ): Promise<DeleteStreamResult> {
    if (shouldDelete?.() === false) return 'superseded';
    const hadCanonicalStream = this.streamLogs.has(stream);
    const result = await this.deleteStreamOnce(
      stream,
      executionId,
      shouldDelete,
    );
    if (result === 'deleted' && hadCanonicalStream) {
      // Re-check immediately before the canonical-deleted notify: a re-claim
      // landing during the goal-forget await (inside `deleteStreamOnce`) must
      // not clear the fresh incarnation's resources.
      if (shouldDelete?.() === false) return 'superseded';
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
        ...this.pendingStreamDeletions.allValues(),
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
    expectedIncarnation: number | undefined,
    pending: Promise<DeleteStreamResult>,
  ): void {
    if (
      this.pendingStreamDeletions.get(stream, expectedIncarnation) !== pending
    ) {
      return;
    }
    this.pendingStreamDeletions.delete(stream, expectedIncarnation);
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
    executionId: ExecutionId | undefined,
    shouldDelete?: () => boolean,
  ): Promise<DeleteStreamResult> {
    if (!canUseStreamDataDir(stream)) return 'deleted';
    if (shouldDelete?.() === false) return 'superseded';

    if (!executionId) {
      try {
        await this.deleteStreamSidecars(stream, shouldDelete);
      } catch (error) {
        if (error instanceof StreamDeletionSupersededError) return 'superseded';
        log.warn(
          `Stream ${stream} was retained because cleanup was incomplete: ${toErrorMessage(error)}`,
          { data: error },
        );
        return 'failed';
      }
      return 'deleted';
    }

    const outcome = await this.deleteExecutionWithStreamState(
      executionId,
      () => this.deleteStreamSidecars(stream, shouldDelete),
      shouldDelete,
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
      case 'superseded':
        return 'superseded';
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
    shouldDelete?: () => boolean,
  ): Promise<ExecutionDeletionOutcome> {
    if (shouldDelete?.() === false) return { kind: 'superseded' };
    let cleanupCompleted = false;
    try {
      const result = await this.deleteExecution(executionId, {
        beforeDelete: async () => {
          if (shouldDelete?.() === false) {
            throw new StreamDeletionSupersededError();
          }
          await cleanup();
          cleanupCompleted = true;
        },
      });
      return { kind: 'completed', result };
    } catch (error) {
      if (error instanceof StreamDeletionSupersededError) {
        return { kind: 'superseded' };
      }
      return cleanupCompleted
        ? { kind: 'streams-deleted', error }
        : { kind: 'retained', error };
    }
  }

  /**
   * Whether this instance still holds state a deletion could act on: a
   * transcript index entry, or a resident sidecar record — which is also the
   * only in-memory source of the stream's execution edge. Both reads are
   * in-memory, so this is the cheap admission for the repeat deletions a
   * republished removal fact produces.
   *
   * False is not a claim that nothing is on disk, only that nothing this
   * instance knows about is: staged residue no index entry refers to any more
   * belongs to the orphan sweep, which enumerates `listStagedDeletions`.
   */
  private hasResidentStreamState(stream: StreamTabId): boolean {
    return (
      this.streamLogs.has(stream) ||
      this.snapshots.hasProvenance(stream) ||
      this.snapshots.getRunMetadata(stream, { quiet: true }).executionId !==
        undefined
    );
  }

  /**
   * The stream→execution edge. Live deletion paths resolve the current
   * execution from the resident snapshot record first: `run.start` updates
   * the in-memory record synchronously. A stream with no resident record
   * resolves through the authored `meta.streamId` index; one with neither has
   * no owned execution — name resemblance is never ownership, so no suffix
   * derivation exists.
   *
   * Absence from the index is proof of that only while every row was
   * readable. An unreadable execution still holds a `meta.streamId` that may
   * name this stream, so ownership is unknown and this fails closed: the
   * caller retains the stream instead of deleting it without its lane.
   */
  private async executionIdForStream(
    stream: StreamTabId,
  ): Promise<ExecutionId | undefined> {
    const resident = this.snapshots.getRunMetadata(stream, {
      quiet: true,
    }).executionId;
    if (resident) return resident;
    const { byStream, unreadable } = await readExecutionStreamIndex();
    const indexed = byStream.get(stream);
    if (indexed) return indexed;
    if (unreadable.size > 0) {
      throw new Error(
        `${unreadable.size} execution record(s) could not be read, so nothing proves stream ${stream} unowned`,
      );
    }
    return undefined;
  }

  /**
   * Recover deletions a crash interrupted, so a stream with staged residue can
   * be staged again. `selectedStreams` narrows the recovery to the streams the
   * caller is about to delete; every other interrupted deletion keeps its own
   * owner.
   */
  private async reconcileStagedDeletions(
    liveStreams: ReadonlySet<StreamTabId>,
    selectedStreams?: ReadonlySet<StreamTabId>,
  ): Promise<void> {
    const reconciliation = await this.snapshots.reconcileStagedDeletions(
      liveStreams,
      selectedStreams,
    );
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

  deleteAll(options?: {
    readonly shouldDelete?: (stream: StreamTabId) => boolean;
  }): Promise<DeleteAllStreamsResult> {
    if (this.pendingDeleteAll) return this.pendingDeleteAll;
    const pending = this.enqueueDeletion(() =>
      this.deleteAllOnce(options?.shouldDelete),
    );
    this.pendingDeleteAll = pending;
    const finish = (): void => this.finishDeleteAll(pending);
    void pending.then(finish, finish);
    return pending;
  }

  private finishDeleteAll(pending: Promise<DeleteAllStreamsResult>): void {
    if (this.pendingDeleteAll === pending) this.pendingDeleteAll = undefined;
  }

  private async deleteAllOnce(
    shouldDeleteStream?: (stream: StreamTabId) => boolean,
  ): Promise<DeleteAllStreamsResult> {
    await this.reconcileStagedDeletions(new Set(this.streamLogs.keys()));
    const [persistedStreams, stagedDeletions] = await Promise.all([
      this.snapshots.listPersistedStreams(),
      this.snapshots.listStagedDeletions(),
    ]);
    const snapshotStreams = unique([...persistedStreams, ...stagedDeletions]);
    const canonicalStreams = new Set(this.streamLogs.keys());
    const streamIds = unique([...snapshotStreams, ...canonicalStreams]);
    const executionIdsByStream = new Map(this.snapshots.getExecutionIdMap());
    const { byStream, unreadable } = await readExecutionStreamIndex();
    for (const stream of snapshotStreams) {
      if (executionIdsByStream.has(stream)) continue;
      const executionId = byStream.get(stream);
      if (executionId) executionIdsByStream.set(stream, executionId);
    }

    const active = new Set<StreamTabId>();
    const deleted = new Set<StreamTabId>();
    const failed = new Set<StreamTabId>();
    const streamsByExecution = new Map<ExecutionId, StreamTabId[]>();
    const streamsWithoutExecution: StreamTabId[] = [];
    for (const stream of streamIds) {
      const executionId = executionIdsByStream.get(stream);
      if (!executionId) {
        if (unreadable.size > 0) {
          // Per-stream isolation: one unreadable ownership record retains that
          // stream instead of failing the whole bulk deletion. Its
          // `meta.streamId` may name this stream, so deleting the sidecars
          // would orphan an execution directory nothing points at any more.
          log.warn(
            `Stream ${stream} was retained because ${unreadable.size} execution record(s) could not be read, so nothing proves it unowned`,
          );
          failed.add(stream);
          continue;
        }
        streamsWithoutExecution.push(stream);
        continue;
      }
      const streams = streamsByExecution.get(executionId) ?? [];
      streams.push(stream);
      streamsByExecution.set(executionId, streams);
    }
    await Promise.all(
      streamsWithoutExecution.map(async (stream) => {
        const shouldDelete = shouldDeleteStream
          ? () => shouldDeleteStream(stream)
          : undefined;
        try {
          await this.deleteStreamSidecars(stream, shouldDelete);
          deleted.add(stream);
          if (canonicalStreams.has(stream)) await this.notifyDeleted(stream);
        } catch (error) {
          if (error instanceof StreamDeletionSupersededError) {
            active.add(stream);
            return;
          }
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
        let supersededAdjacentStreams = new Set<StreamTabId>();
        const shouldDelete = shouldDeleteStream
          ? () => streams.every((stream) => shouldDeleteStream(stream))
          : undefined;
        const outcome = await this.deleteExecutionWithStreamState(
          executionId,
          async () => {
            const cleanup = await this.deleteAdjacentStreamStates(
              streams,
              shouldDeleteStream,
            );
            failedAdjacentStreams = cleanup.failed;
            supersededAdjacentStreams = cleanup.superseded;
            throwAggregated(
              cleanup.failures,
              'Multiple adjacent cleanups failed',
            );
            if (cleanup.superseded.size > 0) {
              throw new StreamDeletionSupersededError();
            }
          },
          shouldDelete,
        );

        if (outcome.kind === 'completed') {
          if (outcome.result.status === 'active') {
            for (const stream of streams) active.add(stream);
          } else {
            for (const stream of streams) deleted.add(stream);
            await this.notifyCanonicalDeletions(streams, canonicalStreams);
          }
          return;
        }
        if (outcome.kind === 'streams-deleted') {
          for (const stream of streams) deleted.add(stream);
          log.warn(
            `Streams for execution ${executionId} were deleted, but execution cleanup was incomplete: ${toErrorMessage(outcome.error)}`,
            { data: outcome.error },
          );
          await this.notifyCanonicalDeletions(streams, canonicalStreams);
          return;
        }
        if (outcome.kind === 'superseded') {
          if (supersededAdjacentStreams.size === 0) {
            for (const stream of streams) active.add(stream);
            return;
          }
          for (const stream of supersededAdjacentStreams) active.add(stream);
          for (const stream of streams) {
            if (!supersededAdjacentStreams.has(stream)) deleted.add(stream);
          }
          await this.notifyCanonicalDeletions(
            streams,
            canonicalStreams,
            supersededAdjacentStreams,
          );
          return;
        }
        log.warn(
          `Failed to delete streams for execution ${executionId}: ${toErrorMessage(outcome.error)}`,
          { data: outcome.error },
        );
        // `retained` normally means execution deletion failed before its
        // `beforeDelete` cleanup committed. When adjacent cleanup did run,
        // retain only the streams that failed or were superseded; the others
        // committed and belong in `deleted`. With no adjacent outcome, cleanup
        // never ran, so `deleted` must stay empty even for snapshot-only
        // identities that have no canonical tab to report in `failed`.
        const retainedAdjacentStreams = new Set([
          ...failedAdjacentStreams,
          ...supersededAdjacentStreams,
        ]);
        if (retainedAdjacentStreams.size === 0) {
          for (const stream of streams) {
            if (this.streamLogs.has(stream)) failed.add(stream);
          }
          return;
        }
        for (const stream of failedAdjacentStreams) failed.add(stream);
        for (const stream of supersededAdjacentStreams) active.add(stream);
        for (const stream of streams) {
          if (!retainedAdjacentStreams.has(stream)) deleted.add(stream);
        }
        await this.notifyCanonicalDeletions(
          streams,
          canonicalStreams,
          retainedAdjacentStreams,
        );
      }),
    );
    return { active, failed, deleted };
  }

  /**
   * The sweep every process owner runs once per launch: drop leftover
   * background shells, then persisted state no live stream refers to.
   *
   * One entry point so the order lives in one place. It matters: the ephemeral
   * sweep removes streams from the transcript index, and the orphan sweep reads
   * that index as its live set — running them the other way round would take
   * the shells' own sidecars for orphans on the next launch instead of this one.
   *
   * `runningStreams` names the streams this process is running right now. It
   * is what makes the sweep safe off the bring-up path: those streams are
   * never offered to the ephemeral half (whose deletions would otherwise queue
   * behind a live execution lane for the run's whole lifetime), and they are
   * retained by the orphan half. A caller sweeping before any run can exist
   * may leave it out.
   *
   * Resolves to the streams it removed from the transcript index. Running off
   * the ready path means a presentation may already be showing them, and no
   * host repaints a rail for a deletion the store made on its own, so the
   * caller owns telling presentations they are gone. The orphan half is not
   * listed: by construction it only touches persisted state no index entry
   * refers to, which nothing renders.
   */
  async sweepLeftoverStreams(options?: {
    readonly runningStreams?: ReadonlySet<StreamTabId>;
  }): Promise<readonly StreamTabId[]> {
    const running = options?.runningStreams ?? new Set<StreamTabId>();
    const sweptShells = await this.sweepEphemeralStreams(
      new Set(
        [...this.streamLogs.keys()].filter((stream) => !running.has(stream)),
      ),
    );
    // The ephemeral half has already committed its deletions by now, so a
    // failure in the orphan half must not hide them from the caller: the
    // shells it swept still need their presentation removal published.
    try {
      const orphans = await this.sweepOrphanedStreams(
        new Set([...this.streamLogs.keys(), ...running]),
      );
      if (orphans.streams.length > 0 || orphans.executionIds.length > 0) {
        log.info(
          `Removed ${orphans.streams.length} orphaned stream sidecar(s) and ${orphans.executionIds.length} execution dir(s).`,
          { data: orphans },
        );
      }
    } catch (error) {
      log.warn(
        `The orphaned-stream sweep did not finish: ${toErrorMessage(error)}`,
        { data: error },
      );
    }
    return sweptShells;
  }

  /**
   * Delete background-shell streams left behind by a process that is not
   * running them any more.
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
   * `candidates` is the caller's contract that none of these streams is
   * running in this process. It matters because `deleteStream` does not refuse
   * a live stream, it queues behind its execution lane: a shell this process
   * started would hold the sequential loop below (and an unresolved
   * `pendingStreamDeletions` entry that `waitForPendingStreamDeletions` awaits)
   * for the command's whole lifetime. `sweepLeftoverStreams` filters them out.
   *
   * A shell another process is still running holds its execution lease, so
   * `deleteStream` answers `'active'` and keeps it — the durable lease is the
   * liveness authority for those, not an in-memory phase. The cost is that a
   * shell whose host crashed inside the lease's staleness window is retained
   * (loudly) until the next launch.
   */
  private async sweepEphemeralStreams(
    candidates: ReadonlySet<StreamTabId>,
  ): Promise<StreamTabId[]> {
    const swept: StreamTabId[] = [];
    const retained: StreamTabId[] = [];
    for (const stream of candidates) {
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
    // On the deletion queue so this pass is ordered against this instance's
    // own deletions. It cannot order it against another instance's — the
    // queue is per-instance and this sweep runs on a `SessionStores` of its
    // own — so exclusion with a concurrent scoped reconcile comes from the
    // coordinator underneath both (`StagedDeletionCoordinator.reconcile`).
    await this.enqueueDeletion(() =>
      this.reconcileStagedDeletions(liveStreams),
    );
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

    // One walk of the executions directory for both halves: the stream half
    // resolves each orphan's owning execution from it, and the execution half
    // takes the same references. Reading it twice cost a second full scan of
    // every execution's metadata for exactly the same answer.
    let listing: ExecutionStreamReferenceListing;
    try {
      listing = await this.listExecutionStreamReferences();
    } catch (error) {
      // Ownership is unknown for every row, and unknown state is never swept.
      log.warn(
        `Skipping orphan cleanup; the executions directory could not be listed: ${toErrorMessage(error)}`,
        { data: error },
      );
      return { streams: [], executionIds: [] };
    }
    const { references, unreadable } = listing;
    const byStream = new Map(
      references.map(({ streamId, executionId }) => [streamId, executionId]),
    );
    await Promise.all(
      orphanedStreams.map(async (stream) => {
        // `liveStreams` is a snapshot the caller took before this sweep's
        // awaits. Off the bring-up path a stream can be registered after it —
        // a new chat tab, a fresh background shell — and `ensureStream` puts
        // it in the transcript index at once, so the fresh persisted listing
        // holds a stream the stale snapshot does not and it would read as an
        // orphan. Liveness is therefore re-read here, and again after staging
        // through `shouldDelete`, the way `sweepOrphanedExecutions` does.
        if (this.streamLogs.has(stream)) return;
        const shouldDelete = (): boolean => !this.streamLogs.has(stream);
        // `shouldDelete` re-reads the cached index, which is all a
        // synchronous guard can do. This is the same question put to the
        // shared store, and the sidecar deletion asks it once more in its
        // post-staging window, immediately before the transcript delete and
        // the irreversible sidecar commit. What remains is the window between
        // that answer and the commit: a host registering this id inside it
        // has its registration erased by our delete. Closing that would take
        // a cross-host lock, which no deletion path here holds.
        const stillOrphaned = async (): Promise<boolean> =>
          !(await this.streamLogs.hasAuthoritativeStream(stream));
        try {
          // This instance's summary index only knows the streams it opened
          // with. Another host can register one after that, and its transcript
          // lives in the shared authoritative store alone — deleting this
          // stream's sidecars and execution would erase live state. Only the
          // durable index may admit the irreversible delete, exactly as
          // `sweepOrphanedExecutions` does; the cached index above stays the
          // prefilter, and this costs one authoritative read per candidate.
          if (!(await stillOrphaned())) return;
          const executionId = byStream.get(stream);
          if (executionId) {
            const outcome = await this.deleteExecutionWithStreamState(
              executionId,
              () =>
                this.deleteStreamSidecars(stream, shouldDelete, stillOrphaned),
              shouldDelete,
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
                `Skipping orphaned execution cleanup for ${executionId}; the sweep continues.`,
                { data: outcome.error },
              );
              return;
            }
            if (outcome.kind === 'superseded') return;
            if (outcome.result.status === 'active') return;
            if (outcome.result.status === 'deleted') {
              sweptExecutionIds.push(executionId);
            }
          } else {
            if (unreadable.size > 0) {
              // Absence from the index proves this stream unowned only when
              // every execution was readable. One unreadable record makes it
              // unknown state, and unknown state is never swept, matching
              // `sweepOrphanedExecutions`.
              log.warn(
                `Retaining orphaned stream ${stream}: ${unreadable.size} execution record(s) could not be read, so its ownership is unknown.`,
              );
              return;
            }
            await this.deleteStreamSidecars(
              stream,
              shouldDelete,
              stillOrphaned,
            );
          }
          sweptStreams.push(stream);
        } catch (error) {
          // A stream registered while this deletion was staging is not a
          // failure: the guard rolled the staging back and kept it.
          if (error instanceof StreamDeletionSupersededError) return;
          log.warn(
            `Skipping orphaned stream cleanup for ${stream}; the sweep continues.`,
            { data: error },
          );
        }
      }),
    );
    // The stream half already deleted these execution directories; offering
    // them again only costs a lease read and a delete of nothing.
    const deletedExecutionIds = new Set(sweptExecutionIds);
    sweptExecutionIds.push(
      ...(await this.sweepOrphanedExecutions(
        liveStreams,
        references.filter(
          ({ executionId }) => !deletedExecutionIds.has(executionId),
        ),
      )),
    );
    return { streams: sweptStreams, executionIds: sweptExecutionIds };
  }

  /**
   * Sweep execution directories whose explicit metadata reference is absent
   * from the persistent transcript index. Metadata without a `streamId` and
   * unreadable metadata stay untouched: they do not establish ownership.
   *
   * `references` comes from the caller's single walk of the executions
   * directory rather than a second one of its own.
   */
  private async sweepOrphanedExecutions(
    liveStreams: ReadonlySet<StreamTabId>,
    references: ExecutionStreamReferenceListing['references'],
  ): Promise<ExecutionId[]> {
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
          `Skipping orphaned execution cleanup for ${executionId}; the sweep continues.`,
          { data: error },
        );
      }
    }
    return swept;
  }

  private async deleteStreamSidecars(
    stream: StreamTabId,
    shouldDelete?: () => boolean,
    /**
     * An asynchronous second opinion, checked in the same post-staging
     * window as `shouldDelete`. The sweep passes the shared transcript store
     * here because `shouldDelete` is synchronous and can only read this
     * process's cached index (see `sweepOrphanedStreams`).
     */
    confirmDeletable?: () => Promise<boolean>,
  ): Promise<void> {
    const snapshotDeletion = await this.snapshots.stageDeleteStream(
      stream,
      (children) => this.notifyChildrenDetached(stream, children),
    );
    // The generation guard is re-checked after staging: `stageDeleteStream`
    // awaits, and a workflow relaunch can claim the identity during that
    // await. Only an unchanged generation may cross the transcript commit
    // point below; a superseded deletion rolls its staging back and leaves
    // the fresh incarnation untouched.
    // `confirmDeletable` reads the durable store and can reject; a read that
    // fails after staging is treated as "not deletable" so the staging is
    // rolled back rather than left neither committed nor rolled back.
    let confirmed = shouldDelete?.() !== false;
    if (confirmed && confirmDeletable) {
      try {
        confirmed = await confirmDeletable();
      } catch (error) {
        log.warn(
          `Stream ${stream} deletion could not be confirmed against the shared store; retaining it: ${toErrorMessage(error)}`,
          { data: error },
        );
        confirmed = false;
      }
    }
    if (!confirmed) {
      try {
        await snapshotDeletion.rollback();
      } catch (rollbackError) {
        log.warn(
          `Stream ${stream} deletion was superseded, but snapshot staging rollback was incomplete: ${toErrorMessage(rollbackError)}`,
          { data: rollbackError },
        );
      }
      throw new StreamDeletionSupersededError(stream);
    }
    await deleteTranscriptWithSnapshotRollback(
      stream,
      snapshotDeletion,
      async () => {
        // The transcript registry is the commit point for tab visibility. The
        // guard travels into `delete` itself so it is re-checked after the
        // durable transcript delete but before in-memory state is forgotten.
        await this.streamLogs.delete(stream, { shouldDelete });
        // `delete` re-checked the guard before forgetting in-memory state.
        // This final check runs with no await between it and the snapshot
        // commit, so a re-claim that landed during the transcript I/O above
        // can roll the snapshot staging back instead of having its buffered
        // sidecar writes discarded by `commit`.
        if (shouldDelete?.() === false) {
          throw new StreamDeletionSupersededError(stream);
        }
      },
    );

    // The snapshot commit is the irreversible sidecar delete. Inspect its
    // supersede result rather than swallowing it in `allSettled`: a re-claim
    // landing during the staged copy's delete must report `superseded`, not
    // `deleted`, so `deleteStreamOnce` skips the canonical-deleted notify and
    // this removal never forgets the fresh incarnation's goal or clears its
    // resources.
    let superseded = false;
    try {
      superseded = await snapshotDeletion.commit(shouldDelete);
    } catch (error) {
      // The transcript already committed, so a snapshot-cleanup failure keeps
      // the deletion `deleted`; it is logged here and still followed by goal
      // cleanup, matching the prior best-effort auxiliary-cleanup contract.
      log.warn(
        `Stream ${stream} was deleted, but snapshot commit was incomplete: ${toErrorMessage(error)}`,
        { data: error },
      );
    }
    if (superseded) {
      throw new StreamDeletionSupersededError(stream);
    }
    // Re-check before the awaited goal forget and before this method reports
    // the deletion committed: a re-claim landing during the snapshot commit's
    // child-detachment/flush must not forget the fresh incarnation's goal.
    if (shouldDelete?.() === false) {
      throw new StreamDeletionSupersededError(stream);
    }
    await this.forgetGoalEntry(stream);
  }

  /** Drop a deleted stream's goal entry; a failure is loud, never fatal. */
  private async forgetGoalEntry(stream: StreamTabId): Promise<void> {
    if (!this.goalEntries) return;
    try {
      await this.goalEntries.forget(stream);
    } catch (error) {
      log.warn(
        `Stream ${stream} was deleted, but goal cleanup was incomplete: ${toErrorMessage(error)}`,
        { data: error },
      );
    }
  }

  private async deleteAdjacentStreamStates(
    streams: readonly StreamTabId[],
    shouldDeleteStream?: (stream: StreamTabId) => boolean,
  ): Promise<{
    failed: Set<StreamTabId>;
    superseded: Set<StreamTabId>;
    failures: unknown[];
  }> {
    const failed = new Set<StreamTabId>();
    const superseded = new Set<StreamTabId>();
    const failures: unknown[] = [];
    await Promise.all(
      streams.map(async (stream) => {
        try {
          await this.deleteStreamSidecars(
            stream,
            shouldDeleteStream ? () => shouldDeleteStream(stream) : undefined,
          );
        } catch (error) {
          if (error instanceof StreamDeletionSupersededError) {
            superseded.add(stream);
            return;
          }
          failed.add(stream);
          failures.push(error);
        }
      }),
    );
    return { failed, superseded, failures };
  }
}
