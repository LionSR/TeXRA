// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - agent types
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - tool-use snapshots
import type { ToolUseSessionSnapshot } from './ToolUseSnapshotTypes';

const CHANNEL = 'ToolUseResumeQueue';
const logger = new AgentLogger(CHANNEL);

interface ResumingSessionState {
  queuedFollowUps: string[];
}

/**
 * Manages in-memory queues for pending tool-use snapshots and follow-ups while
 * a session is resuming. Persistence is handled separately by the
 * {@link ToolUseSessionPersistence} helper and {@link ToolUseSnapshotStore}.
 */
export class ToolUseResumeQueue {
  private static readonly pendingSnapshots = new Map<
    StreamTabId,
    ToolUseSessionSnapshot
  >();
  private static readonly snapshotsByExecution = new Map<
    ExecutionId,
    ToolUseSessionSnapshot
  >();
  private static readonly resumingSessions = new Map<
    StreamTabId,
    ResumingSessionState
  >();

  /** Checks if a snapshot is cached for the provided stream identifier. */
  public static hasPendingSnapshot(streamId: StreamTabId): boolean {
    return this.pendingSnapshots.has(streamId);
  }

  /** Registers persisted snapshots so they can be resumed lazily. */
  public static registerPendingSnapshots(
    snapshots: ToolUseSessionSnapshot[],
  ): void {
    if (snapshots.length === 0) {
      return;
    }

    for (const snapshot of snapshots) {
      this.pendingSnapshots.set(snapshot.streamId as StreamTabId, snapshot);
      this.snapshotsByExecution.set(
        snapshot.executionId as ExecutionId,
        snapshot,
      );
    }

    logger.debug(
      `Registered ${snapshots.length} pending tool-use snapshots for lazy resume.`,
    );
  }

  /** Clears all cached snapshots. */
  public static clearAllPendingSnapshots(): void {
    if (this.pendingSnapshots.size === 0) {
      return;
    }

    this.pendingSnapshots.clear();
    this.snapshotsByExecution.clear();
    logger.debug('Cleared all pending tool-use snapshots.');
  }

  /** Retrieves a cached snapshot for the provided stream without consuming it. */
  public static getSnapshotForStream(
    streamId: StreamTabId,
  ): ToolUseSessionSnapshot | undefined {
    return this.pendingSnapshots.get(streamId);
  }

  /** Consumes and removes a cached snapshot for the provided stream. */
  public static consumeSnapshotForStream(
    streamId: StreamTabId,
  ): ToolUseSessionSnapshot | undefined {
    const snapshot = this.pendingSnapshots.get(streamId);
    if (snapshot) {
      this.pendingSnapshots.delete(streamId);
      this.snapshotsByExecution.delete(snapshot.executionId as ExecutionId);
      logger.debug(
        `Consuming pending snapshot for stream ${streamId} to resume lazily.`,
      );
    }
    return snapshot;
  }

  /** Removes a cached snapshot for the provided stream without consuming it. */
  public static clearPendingSnapshot(streamId: StreamTabId): void {
    const snapshot = this.pendingSnapshots.get(streamId);
    if (!snapshot) {
      return;
    }

    this.pendingSnapshots.delete(streamId);
    this.snapshotsByExecution.delete(snapshot.executionId as ExecutionId);
    logger.debug(`Cleared pending snapshot for stream ${streamId}.`);
  }

  /** Removes a cached snapshot for the provided execution identifier. */
  public static clearPendingSnapshotByExecution(
    executionId: ExecutionId,
  ): ToolUseSessionSnapshot | undefined {
    const snapshot = this.snapshotsByExecution.get(executionId);
    if (!snapshot) {
      return undefined;
    }

    this.snapshotsByExecution.delete(executionId);
    this.pendingSnapshots.delete(snapshot.streamId as StreamTabId);
    logger.debug(`Cleared pending snapshot for execution ${executionId}.`);
    return snapshot;
  }

  /** Adds a pending snapshot or replaces an existing entry for the stream. */
  public static cacheSnapshot(snapshot: ToolUseSessionSnapshot): void {
    this.pendingSnapshots.set(snapshot.streamId as StreamTabId, snapshot);
    this.snapshotsByExecution.set(
      snapshot.executionId as ExecutionId,
      snapshot,
    );
    logger.debug(
      `Cached pending snapshot for stream ${snapshot.streamId} after persistence.`,
    );
  }

  /** Determines whether the provided stream is currently marked as resuming. */
  public static isResumingSession(streamId: StreamTabId): boolean {
    return this.resumingSessions.has(streamId);
  }

  /** Marks a stream as resuming so follow-ups can be queued until the agent is ready. */
  public static setResumingSession(streamId: StreamTabId): void {
    if (this.resumingSessions.has(streamId)) {
      return;
    }

    this.resumingSessions.set(streamId, { queuedFollowUps: [] });
    logger.debug(`Marked stream ${streamId} as resuming.`);
  }

  /** Adds a follow-up to the queue while a snapshot is being resumed. */
  public static enqueueFollowUpWhileResuming(
    streamId: StreamTabId,
    followUp: string,
  ): boolean {
    const entry = this.resumingSessions.get(streamId);
    if (!entry) {
      return false;
    }

    entry.queuedFollowUps.push(followUp);
    logger.debug(
      `Queued follow-up while resuming stream ${streamId}; ${entry.queuedFollowUps.length} waiting.`,
    );
    return true;
  }

  /** Retrieves and clears queued follow-ups for a resuming session. */
  public static drainQueuedFollowUps(streamId: StreamTabId): string[] {
    const entry = this.resumingSessions.get(streamId);
    if (!entry) {
      return [];
    }

    const queued = entry.queuedFollowUps.splice(0);
    logger.debug(
      `Drained ${queued.length} queued follow-ups for stream ${streamId} after resume.`,
    );
    return queued;
  }

  /** Clears a resuming session without draining queued follow-ups (used on failure). */
  public static clearResumingSession(streamId: StreamTabId): void {
    if (this.resumingSessions.delete(streamId)) {
      logger.debug(`Cleared resuming session tracking for stream ${streamId}.`);
    }
  }
}

export type { ToolUseSessionSnapshot } from './ToolUseSnapshotTypes';
