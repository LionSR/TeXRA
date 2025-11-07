// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - agent types
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - tool-use snapshots
import type { ToolUseSessionSnapshot } from './ToolUseSnapshotTypes';

const CHANNEL = 'ToolUseSnapshotCache';
const logger = new AgentLogger(CHANNEL);

export class ToolUseSnapshotCache {
  private static readonly byExecution = new Map<
    ExecutionId,
    ToolUseSessionSnapshot
  >();
  private static readonly executionByStream = new Map<
    StreamTabId,
    ExecutionId
  >();

  static hasSnapshot(streamId: StreamTabId): boolean {
    return this.executionByStream.has(streamId);
  }

  static registerSnapshots(snapshots: ToolUseSessionSnapshot[]): void {
    if (snapshots.length === 0) {
      return;
    }

    for (const snapshot of snapshots) {
      const executionId = snapshot.executionId as ExecutionId;
      const streamId = snapshot.streamId as StreamTabId;
      this.byExecution.set(executionId, snapshot);
      this.executionByStream.set(streamId, executionId);
    }

    logger.debug(
      `Registered ${snapshots.length} pending tool-use snapshots for lazy resume.`,
    );
  }

  static cacheSnapshot(snapshot: ToolUseSessionSnapshot): void {
    const executionId = snapshot.executionId as ExecutionId;
    const streamId = snapshot.streamId as StreamTabId;
    this.byExecution.set(executionId, snapshot);
    this.executionByStream.set(streamId, executionId);
    logger.debug(
      `Cached pending snapshot for stream ${snapshot.streamId} after persistence.`,
    );
  }

  static consumeByStream(
    streamId: StreamTabId,
  ): ToolUseSessionSnapshot | undefined {
    const executionId = this.executionByStream.get(streamId);
    if (!executionId) {
      return undefined;
    }
    const snapshot = this.byExecution.get(executionId);
    if (!snapshot) {
      this.executionByStream.delete(streamId);
      return undefined;
    }
    this.executionByStream.delete(streamId);
    this.byExecution.delete(executionId);
    logger.debug(
      `Consuming pending snapshot for stream ${streamId} to resume.`,
    );
    return snapshot;
  }

  static getByStream(
    streamId: StreamTabId,
  ): ToolUseSessionSnapshot | undefined {
    const executionId = this.executionByStream.get(streamId);
    if (!executionId) {
      return undefined;
    }
    return this.byExecution.get(executionId);
  }

  static clearByStream(streamId: StreamTabId): void {
    const executionId = this.executionByStream.get(streamId);
    if (!executionId) {
      return;
    }
    this.executionByStream.delete(streamId);
    this.byExecution.delete(executionId);
    logger.debug(`Cleared pending snapshot for stream ${streamId}.`);
  }

  static clearByExecution(
    executionId: ExecutionId,
  ): ToolUseSessionSnapshot | undefined {
    const snapshot = this.byExecution.get(executionId);
    if (!snapshot) {
      return undefined;
    }
    this.byExecution.delete(executionId);
    this.executionByStream.delete(snapshot.streamId as StreamTabId);
    logger.debug(`Cleared pending snapshot for execution ${executionId}.`);
    return snapshot;
  }

  static clearAll(): void {
    if (this.byExecution.size === 0) {
      return;
    }
    this.byExecution.clear();
    this.executionByStream.clear();
    logger.debug('Cleared all pending tool-use snapshots.');
  }
}
