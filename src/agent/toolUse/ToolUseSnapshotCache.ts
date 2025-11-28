/**
 * In-memory cache for tool-use session snapshots.
 *
 * Manages session snapshots used for lazy resume when the user returns to
 * a tool-use session. Snapshots are indexed by both stream ID and execution ID
 * for efficient lookup and cleanup.
 *
 * @see ToolUseSessionPersistence for disk persistence
 * @see ToolUseSnapshotStore for the persistent storage layer
 */

// Local imports - agent types
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';
// Local imports - core indexing
import { StreamExecutionIndex } from '@agent/core/StreamExecutionIndex';
import { AgentLogger } from '@logger/AgentLogger';

// Local file imports - tool-use snapshots
import type { ToolUseSessionSnapshot } from './ToolUseSnapshotTypes';

const CHANNEL = 'ToolUseSessionManager';
const logger = new AgentLogger(CHANNEL);

/**
 * Manages in-memory caching of tool-use session snapshots for resume capability.
 *
 * This class provides:
 * - Dual-indexed storage (by stream ID and execution ID)
 * - Lazy registration from persisted snapshots on startup
 * - Consume-on-read pattern for single-use resume operations
 */
export class ToolUseSessionManager {
  private static readonly index =
    new StreamExecutionIndex<ToolUseSessionSnapshot>();

  static hasSnapshot(streamId: StreamTabId): boolean {
    return this.index.getByStream(streamId) !== undefined;
  }

  static registerSnapshots(snapshots: ToolUseSessionSnapshot[]): void {
    if (snapshots.length === 0) {
      return;
    }

    for (const snapshot of snapshots) {
      const executionId = snapshot.executionId as ExecutionId;
      const streamId = snapshot.streamId as StreamTabId;
      this.index.set(streamId, executionId, snapshot);
    }

    logger.debug(
      `Registered ${snapshots.length} pending tool-use snapshots for lazy resume.`,
    );
  }

  static cacheSnapshot(snapshot: ToolUseSessionSnapshot): void {
    const executionId = snapshot.executionId as ExecutionId;
    const streamId = snapshot.streamId as StreamTabId;
    this.index.set(streamId, executionId, snapshot);
    logger.debug(
      `Cached pending snapshot for stream ${snapshot.streamId} after persistence.`,
    );
  }

  static consumeByStream(
    streamId: StreamTabId,
  ): ToolUseSessionSnapshot | undefined {
    const entry = this.index.deleteByStream(streamId);
    if (!entry) {
      return undefined;
    }
    logger.debug(
      `Consuming pending snapshot for stream ${streamId} to resume.`,
    );
    return entry.value;
  }

  static getByStream(
    streamId: StreamTabId,
  ): ToolUseSessionSnapshot | undefined {
    return this.index.getByStream(streamId);
  }

  static clearByStream(streamId: StreamTabId): void {
    const entry = this.index.deleteByStream(streamId);
    if (!entry) {
      return;
    }
    logger.debug(`Cleared pending snapshot for stream ${streamId}.`);
  }

  static clearByExecution(
    executionId: ExecutionId,
  ): ToolUseSessionSnapshot | undefined {
    const entry = this.index.deleteByExecution(executionId);
    if (!entry) {
      return undefined;
    }
    logger.debug(`Cleared pending snapshot for execution ${executionId}.`);
    return entry.value;
  }

  static clearAll(): void {
    this.index.clear();
    logger.debug('Cleared all pending tool-use snapshots.');
  }
}
