// Local imports - transcript
import { canUseStreamDataDir } from '@transcript/streamDataPaths';

// Local imports - agent
import { deleteExecution as deleteStoredExecution } from '@agent/storage/executionListing';

// Local imports - logger
import * as logger from '@logger/logUtils';

// Local imports - shared
import type { ExecutionId, StreamTabId } from '@shared/schemas';

// Local imports - utils
import { unique } from '@utils/core';

// Local imports - transcript types
import type { StreamLogStore, StreamSnapshotStore } from '@transcript';

const CHANNEL = 'SessionStores';

export interface SessionStoresOptions {
  streamLogs: StreamLogStore;
  snapshots: StreamSnapshotStore;
  deleteExecution?: (executionId: ExecutionId) => Promise<boolean>;
  goalEntries?: {
    forget(stream: StreamTabId): Promise<void>;
    forgetMany(streams: readonly StreamTabId[]): Promise<void>;
  };
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
  ) => Promise<boolean>;
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

  async deleteStream(stream: StreamTabId): Promise<void> {
    if (!canUseStreamDataDir(stream)) return;

    const executionId =
      this.snapshots.getExecutionId(stream) ??
      (await this.snapshots.readPersistedExecutionId(stream));

    await Promise.all([
      this.streamLogs.delete(stream),
      this.snapshots.deleteStream(stream),
      this.deleteExecutionIds(executionId ? [executionId] : []),
      this.goalEntries?.forget(stream),
    ]);
  }

  async deleteAll(): Promise<void> {
    const persistedStreams = await this.snapshots.listPersistedStreams();
    const streamIds = unique([...persistedStreams, ...this.streamLogs.keys()]);
    const executionIds = new Set<ExecutionId>(
      this.snapshots.getExecutionIdMap().values(),
    );
    for (const stream of persistedStreams) {
      const executionId = await this.snapshots.readPersistedExecutionId(stream);
      if (executionId) executionIds.add(executionId);
    }

    await Promise.all([
      this.streamLogs.clear(),
      this.snapshots.deleteAll(),
      this.deleteExecutionIds(executionIds),
      this.goalEntries?.forgetMany(streamIds),
    ]);
  }

  async sweepOrphanedStreams(
    liveStreams: ReadonlySet<StreamTabId>,
  ): Promise<{ streams: StreamTabId[]; executionIds: ExecutionId[] }> {
    const persistedStreams = await this.snapshots.listPersistedStreams();
    const orphanedStreams = persistedStreams.filter(
      (stream) => !liveStreams.has(stream),
    );
    const sweptStreams: StreamTabId[] = [];
    const executionIds = new Set<ExecutionId>();
    const sweptExecutionIds: ExecutionId[] = [];

    await Promise.all(
      orphanedStreams.map(async (stream) => {
        try {
          const executionId =
            await this.snapshots.readPersistedExecutionId(stream);
          await Promise.all([
            this.snapshots.deleteStream(stream),
            this.goalEntries?.forget(stream),
          ]);
          sweptStreams.push(stream);
          if (executionId) executionIds.add(executionId);
        } catch (error) {
          logger.warn(
            CHANNEL,
            `Skipping orphaned stream cleanup for ${stream}; startup will continue.`,
            { data: error },
          );
        }
      }),
    );
    await Promise.all(
      [...executionIds].map(async (executionId) => {
        try {
          const deleted = await this.deleteExecution(executionId);
          if (deleted) sweptExecutionIds.push(executionId);
        } catch (error) {
          logger.warn(
            CHANNEL,
            `Skipping orphaned execution cleanup for ${executionId}; startup will continue.`,
            { data: error },
          );
        }
      }),
    );

    return { streams: sweptStreams, executionIds: sweptExecutionIds };
  }

  private async deleteExecutionIds(
    executionIds: Iterable<ExecutionId>,
  ): Promise<void> {
    await Promise.all(
      unique(executionIds).map((executionId) =>
        this.deleteExecution(executionId),
      ),
    );
  }
}
