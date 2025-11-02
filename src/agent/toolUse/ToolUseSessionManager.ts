// Local imports - logging
import { createChannelLogger, type ChannelLogger } from '@logger/logUtils';

// Local imports - agent
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - config
import { getToolUsePersistenceEnabled } from '@utils/config';

// Local imports - store
import { ToolUseSnapshotStore } from './ToolUseSnapshotStore';
import type {
  SaveToolUseSnapshotPayload,
  ToolUseSessionSnapshot,
} from './ToolUseSnapshotTypes';

const CHANNEL = 'ToolUseSessionManager';
const logger = createChannelLogger(CHANNEL);

interface SnapshotBackend {
  save(payload: SaveToolUseSnapshotPayload): Promise<void>;
  load(executionId: ExecutionId): Promise<ToolUseSessionSnapshot | null>;
  delete(executionId: ExecutionId): Promise<void>;
  list(): Promise<ToolUseSessionSnapshot[]>;
  deleteAll(): Promise<void>;
}

const noopSnapshotBackend: SnapshotBackend = {
  async save() {},
  async load() {
    return null;
  },
  async delete() {},
  async list() {
    return [];
  },
  async deleteAll() {},
};

function resolveSnapshotBackend(): SnapshotBackend {
  return getToolUsePersistenceEnabled()
    ? (ToolUseSnapshotStore as SnapshotBackend)
    : noopSnapshotBackend;
}

interface ResumingSessionState {
  queuedFollowUps: string[];
}

/**
 * Coordinates runtime state for resuming tool-use sessions. All persistence is
 * handled by {@link ToolUseSnapshotStore}; keep this class focused on
 * in-memory queues.
 */
export class ToolUseSessionManager {
  private static readonly pendingSnapshots = new Map<
    StreamTabId,
    ToolUseSessionSnapshot
  >();
  private static readonly resumingSessions = new Map<
    StreamTabId,
    ResumingSessionState
  >();

  /** Determine whether the provided stream is currently marked as resuming. */
  public static isResumingSession(streamId: StreamTabId): boolean {
    return this.resumingSessions.has(streamId);
  }

  /** Checks if tool-use session persistence is enabled. */
  public static isPersistenceEnabled(): boolean {
    return getToolUsePersistenceEnabled();
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
    }

    logger.debug(
      `Registered ${snapshots.length} pending tool-use snapshots for lazy resume.`,
    );
  }

  /** Retrieves a cached snapshot for the provided stream without consuming it. */
  public static getSnapshotForStream(
    streamId: StreamTabId,
  ): ToolUseSessionSnapshot | undefined {
    return this.pendingSnapshots.get(streamId);
  }

  /** Marks a stream as resuming so follow-ups can be queued until the agent is ready. */
  public static setResumingSession(streamId: StreamTabId): void {
    if (this.resumingSessions.has(streamId)) {
      return;
    }

    this.resumingSessions.set(streamId, { queuedFollowUps: [] });
    logger.debug(`Marked stream ${streamId} as resuming.`);
  }

  /** Consumes and removes a cached snapshot for the provided stream. */
  public static consumeSnapshotForStream(
    streamId: StreamTabId,
  ): ToolUseSessionSnapshot | undefined {
    const snapshot = this.pendingSnapshots.get(streamId);
    if (snapshot) {
      this.pendingSnapshots.delete(streamId);
      logger.debug(
        `Consuming pending snapshot for stream ${streamId} to resume lazily.`,
      );
    }
    return snapshot;
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

  /** Checks if a snapshot is cached for the provided stream identifier. */
  public static hasPendingSnapshot(streamId: StreamTabId): boolean {
    return this.pendingSnapshots.has(streamId);
  }

  /** Persists a tool-use session snapshot using the snapshot store. */
  public static async saveSnapshot(
    payload: SaveToolUseSnapshotPayload,
  ): Promise<void> {
    const store = resolveSnapshotBackend();
    await store.save(payload);
  }

  /** Loads a tool-use session snapshot from persistent storage. */
  public static async loadSnapshot(
    executionId: ExecutionId,
  ): Promise<ToolUseSessionSnapshot | null> {
    const store = resolveSnapshotBackend();
    return await store.load(executionId);
  }

  /** Deletes a persisted tool-use session snapshot. */
  public static async deleteSnapshot(
    executionId: ExecutionId | undefined,
  ): Promise<void> {
    if (!executionId) {
      return;
    }

    for (const [streamId, snapshot] of this.pendingSnapshots.entries()) {
      if (snapshot.executionId === executionId) {
        this.pendingSnapshots.delete(streamId);
        break;
      }
    }

    const store = resolveSnapshotBackend();
    await store.delete(executionId);
  }

  /** Lists all persisted tool-use session snapshots. */
  public static async listSnapshots(): Promise<ToolUseSessionSnapshot[]> {
    const store = resolveSnapshotBackend();
    return await store.list();
  }

  /** Deletes all persisted tool-use session snapshots. */
  public static async deleteAllSnapshots(): Promise<void> {
    const store = resolveSnapshotBackend();
    await store.deleteAll();
  }
}

export type { ToolUseSessionSnapshot } from './ToolUseSnapshotTypes';
export type { SaveToolUseSnapshotPayload } from './ToolUseSnapshotTypes';
