// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - agent types
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { FollowUpQueue } from './FollowUpQueue';

const CHANNEL = 'ToolUseFollowUpQueue';
const logger = new AgentLogger(CHANNEL);

export class ToolUseFollowUpQueue {
  private static readonly resumingSessions = new Map<
    StreamTabId,
    FollowUpQueue
  >();

  static isResuming(streamId: StreamTabId): boolean {
    return this.resumingSessions.has(streamId);
  }

  static markResuming(streamId: StreamTabId): void {
    if (this.resumingSessions.has(streamId)) {
      return;
    }
    this.resumingSessions.set(streamId, new FollowUpQueue());
    logger.debug(`Marked stream ${streamId} as resuming.`);
  }

  static clearResuming(streamId: StreamTabId): void {
    const queue = this.resumingSessions.get(streamId);
    if (!queue) {
      return;
    }
    queue.dispose();
    this.resumingSessions.delete(streamId);
    logger.debug(`Cleared resuming session tracking for stream ${streamId}.`);
  }

  static enqueue(streamId: StreamTabId, followUp: string): boolean {
    const queue = this.resumingSessions.get(streamId);
    if (!queue) {
      return false;
    }
    queue.enqueue(followUp);
    logger.debug(`Queued follow-up while resuming stream ${streamId}.`);
    return true;
  }

  static drain(streamId: StreamTabId): string[] {
    const queue = this.resumingSessions.get(streamId);
    if (!queue) {
      return [];
    }
    const queued = queue.drain();
    logger.debug(
      `Drained ${queued.length} queued follow-ups for stream ${streamId} after resume.`,
    );
    return queued;
  }
}
