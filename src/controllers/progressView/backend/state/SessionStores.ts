// Local imports - transcript
import { canUseStreamDataDir } from '@transcript/streamDataPaths';

// Local imports - agent
import {
  deleteExecution as deleteStoredExecution,
  type DeleteExecutionOptions,
  type DeleteExecutionResult,
} from '@agent/storage/executionListing';
import { executionIdFromStream } from '@agent/storage/executionIdFromStream';
import { waitForOwnedExecutionLeaseRelease } from '@agent/storage/executionLease';

// Local imports - logger
import * as logger from '@logger/logUtils';

// Local imports - shared
import type { ExecutionId, StreamTabId } from '@shared/schemas';

// Local imports - utils
import { unique } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - transcript types
import type { StreamLogStore, StreamSnapshotStore } from '@transcript';

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
}

export interface DeleteAllStreamsResult {
  readonly active: ReadonlySet<StreamTabId>;
  readonly failed: ReadonlySet<StreamTabId>;
}

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

  constructor(options: SessionStoresOptions) {
    this.streamLogs = options.streamLogs;
    this.snapshots = options.snapshots;
    this.deleteExecution = options.deleteExecution ?? deleteStoredExecution;
    this.goalEntries = options.goalEntries;
  }

  async waitForOwnedExecutionRelease(stream: StreamTabId): Promise<void> {
    const executionId = await this.executionIdForStream(stream);
    if (executionId) await waitForOwnedExecutionLeaseRelease(executionId);
  }

  async deleteStream(stream: StreamTabId): Promise<'deleted' | 'active'> {
    if (!canUseStreamDataDir(stream)) return 'deleted';

    const executionId = await this.executionIdForStream(stream);

    if (!executionId) {
      await this.deleteAdjacentStreamState(stream);
      return 'deleted';
    }
    const result = await this.deleteExecution(executionId, {
      beforeDelete: () => this.deleteAdjacentStreamState(stream),
    });
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

  async deleteAll(): Promise<DeleteAllStreamsResult> {
    const persistedStreams = await this.snapshots.listPersistedStreams();
    const streamIds = unique([...persistedStreams, ...this.streamLogs.keys()]);
    const executionIdsByStream = new Map(this.snapshots.getExecutionIdMap());
    for (const stream of persistedStreams) {
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
        try {
          const result = await this.deleteExecution(executionId, {
            beforeDelete: () => this.deleteAdjacentStreamStates(streams),
          });
          if (result.status === 'active') {
            for (const stream of streams) active.add(stream);
          }
        } catch (error) {
          logger.warn(
            CHANNEL,
            `Failed to delete execution ${executionId}: ${toErrorMessage(error)}`,
            { data: error },
          );
          for (const stream of streams) failed.add(stream);
        }
      }),
    );
    return { active, failed };
  }

  async sweepOrphanedStreams(
    liveStreams: ReadonlySet<StreamTabId>,
  ): Promise<{ streams: StreamTabId[]; executionIds: ExecutionId[] }> {
    const persistedStreams = await this.snapshots.listPersistedStreams();
    const orphanedStreams = persistedStreams.filter(
      (stream) => !liveStreams.has(stream),
    );
    const sweptStreams: StreamTabId[] = [];
    const sweptExecutionIds: ExecutionId[] = [];

    await Promise.all(
      orphanedStreams.map(async (stream) => {
        try {
          const executionId =
            (await this.snapshots.readPersistedExecutionId(stream)) ??
            executionIdFromStream(stream);
          if (executionId) {
            let adjacentCleanupFailed = false;
            let result: DeleteExecutionResult;
            try {
              result = await this.deleteExecution(executionId, {
                beforeDelete: async () => {
                  try {
                    await this.deleteAdjacentStreamState(stream);
                  } catch (error) {
                    adjacentCleanupFailed = true;
                    throw error;
                  }
                },
              });
            } catch (error) {
              if (adjacentCleanupFailed) throw error;
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
    await Promise.all([
      this.streamLogs.delete(stream),
      this.snapshots.deleteStream(stream),
      this.goalEntries?.forget(stream),
    ]);
  }

  private async deleteAdjacentStreamStates(
    streams: readonly StreamTabId[],
  ): Promise<void> {
    await Promise.all([
      ...streams.map((stream) => this.streamLogs.delete(stream)),
      ...streams.map((stream) => this.snapshots.deleteStream(stream)),
      this.goalEntries?.forgetMany(streams),
    ]);
  }
}
