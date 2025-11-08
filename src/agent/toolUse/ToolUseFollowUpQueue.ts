// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - agent identifiers
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - follow-up queue primitive
import { FollowUpQueue } from './FollowUpQueue';

const CHANNEL = 'ToolUseFollowUpQueue';
const logger = new AgentLogger(CHANNEL);

export class ToolUseFollowUpQueue {
  private static readonly queues = new Map<StreamTabId, FollowUpQueue>();
  private static readonly resuming = new Set<StreamTabId>();

  static acquire(streamId: StreamTabId): FollowUpQueue {
    let queue = this.queues.get(streamId);
    if (!queue) {
      queue = new FollowUpQueue();
      this.queues.set(streamId, queue);
    }
    return queue;
  }

  static release(streamId: StreamTabId): void {
    const queue = this.queues.get(streamId);
    if (!queue) {
      return;
    }
    queue.dispose();
    this.queues.delete(streamId);
    this.resuming.delete(streamId);
    logger.debug(`Released follow-up queue for stream ${streamId}.`);
  }

  static markResuming(streamId: StreamTabId): FollowUpQueue {
    const queue = this.acquire(streamId);
    if (!this.resuming.has(streamId)) {
      this.resuming.add(streamId);
      logger.debug(`Marked stream ${streamId} as resuming.`);
    }
    return queue;
  }

  static clearResuming(streamId: StreamTabId): void {
    if (!this.resuming.delete(streamId)) {
      return;
    }
    logger.debug(`Cleared resuming session tracking for stream ${streamId}.`);
  }

  static isResuming(streamId: StreamTabId): boolean {
    return this.resuming.has(streamId);
  }

  static enqueue(streamId: StreamTabId, followUp: string): boolean {
    const queue = this.queues.get(streamId);
    if (!queue) {
      return false;
    }
    queue.enqueue(followUp);
    logger.debug(`Queued follow-up for stream ${streamId}.`);
    return true;
  }

  static drain(streamId: StreamTabId): string[] {
    const queue = this.queues.get(streamId);
    if (!queue) {
      return [];
    }
    const drained = queue.drain();
    logger.debug(
      `Drained ${drained.length} queued follow-ups for stream ${streamId}.`,
    );
    return drained;
  }

  static get(streamId: StreamTabId): FollowUpQueue | undefined {
    return this.queues.get(streamId);
  }
}
