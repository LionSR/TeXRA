/**
 * Static manager for follow-up queues indexed by stream ID.
 *
 * Provides queue acquisition, release, and coordination for routing
 * follow-ups to active/resuming sessions.
 */

import { STREAM_STATUS } from '@shared/schemas';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { AgentLogger } from '@logger/AgentLogger';
import { FollowUpQueue } from './FollowUpQueue';
import type { StreamTabId } from '@shared/schemas';

const logger = new AgentLogger('ToolUseFollowUpQueue');

/**
 * Static manager for follow-up queues indexed by stream ID.
 */
export class ToolUseFollowUpQueue {
  private static readonly queues = new Map<StreamTabId, FollowUpQueue>();
  /** Streams whose queues were explicitly released (orchestrator disposed). */
  private static readonly released = new Set<StreamTabId>();

  static acquire(streamId: StreamTabId): FollowUpQueue {
    this.released.delete(streamId);
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
    this.released.add(streamId);
    logger.debug(`Released follow-up queue for stream ${streamId}.`);
  }

  /**
   * Check if a stream is currently resuming.
   * Uses StreamStatusService as the single source of truth.
   */
  static isResuming(streamId: StreamTabId): boolean {
    return StreamStatusService.get(streamId) === STREAM_STATUS.RESUMING;
  }

  /**
   * Enqueue a follow-up message for a stream.
   *
   * Auto-creates the queue if it doesn't exist yet (needed for WAITING streams
   * from prior sessions). Silently discards if the queue was explicitly released
   * (orchestrator disposed — late-arriving subagent results).
   */
  static enqueue(streamId: StreamTabId, followUp: string): void {
    if (this.released.has(streamId)) {
      logger.debug(
        `Queue for stream ${streamId} was released, discarding follow-up.`,
      );
      return;
    }
    const queue = this.acquire(streamId);
    queue.enqueue(followUp);
    logger.debug(`Queued follow-up for stream ${streamId}.`);
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

  /**
   * Get all queued follow-up messages for a stream without consuming them.
   * Used for UI display purposes.
   */
  static getAll(streamId: StreamTabId): string[] {
    const queue = this.queues.get(streamId);
    if (!queue) {
      return [];
    }
    return queue.getAll();
  }
}
