// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - agent types
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - core indexing
import { StreamExecutionIndex } from '@agent/core/StreamExecutionIndex';

// Local imports - tool-use snapshots
import type { ToolUseSessionSnapshot } from './ToolUseSnapshotTypes';

const CHANNEL = 'ToolUseSnapshotCache';
const logger = new AgentLogger(CHANNEL);

export class ToolUseSnapshotCache {
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
