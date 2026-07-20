// Third-party imports
import PQueue from 'p-queue';

// Local imports
import {
  deleteExecution as deleteStoredExecution,
  type DeleteExecutionOptions,
  type DeleteExecutionResult,
} from '@agent/storage/executionListing';
import { executionIdFromStream } from '@agent/storage/executionIdFromStream';
import { waitForOwnedExecutionLeaseRelease } from '@agent/storage/executionLease';
import * as logger from '@logger/logUtils';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import type { StreamLogStore, StreamSnapshotStore } from '@transcript';
import { canUseStreamDataDir } from '@transcript/streamDataPaths';
import { unique } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'SessionStores';

export interface SessionStoresOptions {
  streamLogs: StreamLogStore;
  snapshots: StreamSnapshotStore;
  deleteExecution?: (
    executionId: ExecutionId,
    options?: DeleteExecutionOptions,
  ) => Promise<DeleteExecutionResult>;
  goalEntries?: {
    forget(stream: StreamTabId): Promise<void>;
    forgetMany(streams: readonly StreamTabId[]): Promise<void>;
  };
  /** Runs after a canonical transcript stream is committed as deleted. */
  onCanonicalStreamDeleted?: (stream: StreamTabId) => void | Promise<void>;
}

function throwAdjacentCleanupFailures(failures: readonly unknown[]): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Multiple adjacent cleanups failed');
  }
}

export interface DeleteAllStreamsResult {
  readonly active: ReadonlySet<StreamTabId>;
  readonly failed: ReadonlySet<StreamTabId>;
}

export type DeleteStreamResult = 'deleted' | 'active' | 'failed';

/**
 * Owns the durable footprint for a progress stream.
 *
 * `StreamLogStore` and `StreamSnapshotStore` keep separate on-disk formats;
 * this class owns the lifecycle invariant across those formats plus the
 * execution directory they reference.
 */
export class SessionStores {
  private readonly streamLogs: StreamLogStore;
  private readonly snapshots: StreamSnapshotStore;
  private readonly deleteExecution: (
    executionId: ExecutionId,
    options?: DeleteExecutionOptions,
  ) => Promise<DeleteExecutionResult>;
  private readonly goalEntries:
    | {
        forget(stream: StreamTabId): Promise<void>;
        forgetMany(streams: readonly StreamTabId[]): Promise<void>;
      }
    | undefined;
  private readonly onCanonicalStreamDeleted:
    ((stream: StreamTabId) => void | Promise<void>) | undefined;
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
    this.goalEntries = options.goalEntries;
    this.onCanonicalStreamDeleted = options.onCanonicalStreamDeleted;
  }

  async waitForOwnedExecutionRelease(stream: StreamTabId): Promise<void> {
    const executionId = await this.executionIdForStream(stream);
    if (executionId) await waitForOwnedExecutionLeaseRelease(executionId);
  }

  deleteStream(stream: StreamTabId): Promise<DeleteStreamResult> {
    const existing = this.pendingStreamDeletions.get(stream);
    if (existing) return existing;
    const pending = this.enqueueDeletion(async () => {
      const hadCanonicalStream = this.streamLogs.has(stream);
      const result = await this.deleteStreamOnce(stream);
      if (result === 'deleted' && hadCanonicalStream) {
        await this.notifyDeleted(stream);
      }
      return result;
    });
    this.pendingStreamDeletions.set(stream, pending);
    void pending.then(
      () => this.finishStreamDeletion(stream, pending),
      () => this.finishStreamDeletion(stream, pending),
    );
    return pending;
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
      logger.warn(
        CHANNEL,
        `Stream ${stream} was deleted, but canonical session cleanup was incomplete: ${toErrorMessage(error)}`,
        { data: error },
      );
    }
  }

  private async deleteStreamOnce(
    stream: StreamTabId,
  ): Promise<DeleteStreamResult> {
    if (!canUseStreamDataDir(stream)) return 'deleted';

    const executionId = await this.executionIdForStream(stream);

    if (!executionId) {
      try {
        await this.deleteAdjacentStreamState(stream);
      } catch (error) {
        logger.warn(
          CHANNEL,
          `Stream ${stream} was retained because cleanup was incomplete: ${toErrorMessage(error)}`,
          { data: error },
        );
        return 'failed';
      }
      return 'deleted';
    }
    let adjacentCleanupCompleted = false;
    let result: DeleteExecutionResult;
    try {
      result = await this.deleteExecution(executionId, {
        beforeDelete: async () => {
          await this.deleteAdjacentStreamState(stream);
          adjacentCleanupCompleted = true;
        },
      });
    } catch (error) {
      if (adjacentCleanupCompleted) {
        logger.warn(
          CHANNEL,
          `Stream ${stream} was deleted, but execution ${executionId} cleanup was incomplete: ${toErrorMessage(error)}`,
          { data: error },
        );
        return 'deleted';
      }
      logger.warn(
        CHANNEL,
        `Stream ${stream} was retained because cleanup was incomplete: ${toErrorMessage(error)}`,
        { data: error },
      );
      return 'failed';
    }
    return result.status === 'active' ? 'active' : 'deleted';
  }

  private async executionIdForStream(
    stream: StreamTabId,
  ): Promise<ExecutionId | undefined> {
    return (
      this.snapshots.getExecutionId(stream) ??
      (await this.snapshots.readPersistedExecutionId(stream)) ??
      executionIdFromStream(stream)
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
      logger.info(CHANNEL, 'Reconciled interrupted stream deletions', {
        data: reconciliation,
      });
    }
  }

  deleteAll(): Promise<DeleteAllStreamsResult> {
    if (this.pendingDeleteAll) return this.pendingDeleteAll;
    const pending = this.enqueueDeletion(() => this.deleteAllOnce());
    this.pendingDeleteAll = pending;
    void pending.then(
      () => this.finishDeleteAll(pending),
      () => this.finishDeleteAll(pending),
    );
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
    for (const stream of snapshotStreams) {
      const executionId = await this.snapshots.readPersistedExecutionId(stream);
      if (executionId) executionIdsByStream.set(stream, executionId);
      else {
        const derived = executionIdFromStream(stream);
        if (derived) executionIdsByStream.set(stream, derived);
      }
    }
    for (const stream of streamIds) {
      if (executionIdsByStream.has(stream)) continue;
      const derived = executionIdFromStream(stream);
      if (derived) executionIdsByStream.set(stream, derived);
    }

    const streamsByExecution = new Map<ExecutionId, StreamTabId[]>();
    const streamsWithoutExecution: StreamTabId[] = [];
    for (const stream of streamIds) {
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
    const failed = new Set<StreamTabId>();
    await Promise.all(
      streamsWithoutExecution.map(async (stream) => {
        try {
          await this.deleteAdjacentStreamState(stream);
          if (canonicalStreams.has(stream)) await this.notifyDeleted(stream);
        } catch (error) {
          logger.warn(
            CHANNEL,
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
        let adjacentCleanupCompleted = false;
        try {
          const result = await this.deleteExecution(executionId, {
            beforeDelete: async () => {
              const cleanup = await this.deleteAdjacentStreamStates(streams);
              failedAdjacentStreams = cleanup.failed;
              throwAdjacentCleanupFailures(cleanup.failures);
              adjacentCleanupCompleted = true;
            },
          });
          if (result.status === 'active') {
            for (const stream of streams) active.add(stream);
          } else {
            await Promise.all(
              streams
                .filter((stream) => canonicalStreams.has(stream))
                .map((stream) => this.notifyDeleted(stream)),
            );
          }
        } catch (error) {
          if (adjacentCleanupCompleted) {
            logger.warn(
              CHANNEL,
              `Streams for execution ${executionId} were deleted, but execution cleanup was incomplete: ${toErrorMessage(error)}`,
              { data: error },
            );
            await Promise.all(
              streams
                .filter((stream) => canonicalStreams.has(stream))
                .map((stream) => this.notifyDeleted(stream)),
            );
            return;
          }
          logger.warn(
            CHANNEL,
            `Failed to delete streams for execution ${executionId}: ${toErrorMessage(error)}`,
            { data: error },
          );
          const retainedStreams =
            failedAdjacentStreams.size > 0
              ? failedAdjacentStreams
              : streams.filter((stream) => this.streamLogs.has(stream));
          for (const stream of retainedStreams) failed.add(stream);
          if (failedAdjacentStreams.size > 0) {
            await Promise.all(
              streams
                .filter(
                  (stream) =>
                    canonicalStreams.has(stream) &&
                    !failedAdjacentStreams.has(stream),
                )
                .map((stream) => this.notifyDeleted(stream)),
            );
          }
        }
      }),
    );
    return { active, failed };
  }

  async sweepOrphanedStreams(
    liveStreams: ReadonlySet<StreamTabId>,
  ): Promise<{ streams: StreamTabId[]; executionIds: ExecutionId[] }> {
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
            (await this.snapshots.readPersistedExecutionId(stream)) ??
            executionIdFromStream(stream);
          if (executionId) {
            let result: DeleteExecutionResult;
            let adjacentCleanupCompleted = false;
            try {
              result = await this.deleteExecution(executionId, {
                beforeDelete: async () => {
                  await this.deleteAdjacentStreamState(stream);
                  adjacentCleanupCompleted = true;
                },
              });
            } catch (error) {
              if (adjacentCleanupCompleted) {
                sweptStreams.push(stream);
                logger.warn(
                  CHANNEL,
                  `Orphaned stream ${stream} was removed, but execution ${executionId} cleanup was incomplete.`,
                  { data: error },
                );
                return;
              }
              logger.warn(
                CHANNEL,
                `Skipping orphaned execution cleanup for ${executionId}; startup will continue.`,
                { data: error },
              );
              return;
            }
            if (result.status === 'active') return;
            if (result.status === 'deleted') {
              sweptExecutionIds.push(executionId);
            }
          } else {
            await this.deleteAdjacentStreamState(stream);
          }
          sweptStreams.push(stream);
        } catch (error) {
          logger.warn(
            CHANNEL,
            `Skipping orphaned stream cleanup for ${stream}; startup will continue.`,
            { data: error },
          );
        }
      }),
    );
    return { streams: sweptStreams, executionIds: sweptExecutionIds };
  }

  private async deleteAdjacentStreamState(stream: StreamTabId): Promise<void> {
    const snapshotDeletion = await this.snapshots.stageDeleteStream(stream);
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
      logger.warn(
        CHANNEL,
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
    const staged = new Map<
      StreamTabId,
      Awaited<ReturnType<StreamSnapshotStore['stageDeleteStream']>>
    >();
    await Promise.all(
      streams.map(async (stream) => {
        try {
          staged.set(stream, await this.snapshots.stageDeleteStream(stream));
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
      logger.warn(
        CHANNEL,
        `Streams were deleted, but auxiliary cleanup was incomplete: ${toErrorMessage(result.reason)}`,
        { data: result.reason },
      );
    }
    return { failed, failures };
  }
}
