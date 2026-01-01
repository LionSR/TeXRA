/**
 * Static manager for follow-up queues indexed by stream ID.
 *
 * Provides queue acquisition, release, and coordination for routing
 * follow-ups to active/resuming sessions.
 */

import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { STREAM_STATUS } from '@common/constants/streamStatus';
import { AgentLogger } from '@logger/AgentLogger';
import { FollowUpQueue } from './FollowUpQueue';

const logger = new AgentLogger('ToolUseFollowUpQueue');

/**
 * Static manager for follow-up queues indexed by stream ID.
 */
export class ToolUseFollowUpQueue {
  private static readonly queues = new Map<StreamTabId, FollowUpQueue>();

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
    logger.debug(`Released follow-up queue for stream ${streamId}.`);
  }

  /**
   * Check if a stream is currently resuming.
   * Uses StreamStatusService as the single source of truth.
   */
  static isResuming(streamId: StreamTabId): boolean {
    return StreamStatusService.get(streamId) === STREAM_STATUS.RESUMING;
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
}
