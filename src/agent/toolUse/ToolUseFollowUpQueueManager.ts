/**
 * Static manager for follow-up queues indexed by stream ID.
 *
 * Provides queue acquisition, release, and coordination for routing
 * follow-ups to active/resuming sessions.
 */

import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { createChannelTrace } from '@logger';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';
import { FollowUpQueue } from './FollowUpQueue';

const logger = createChannelTrace('ToolUseFollowUpQueue');

/**
 * Static manager for follow-up queues indexed by stream ID.
 */
export class ToolUseFollowUpQueue {
  private static readonly queues = new Map<StreamTabId, FollowUpQueue>();
  /** Streams whose queues were explicitly released (orchestrator disposed). */
  private static readonly released = new Set<StreamTabId>();
  private static readonly RELEASED_CAP = 500;
  /** Observers notified whenever a stream's queue is released. */
  private static readonly releaseObservers = new Set<
    (streamId: StreamTabId) => void
  >();

  /**
   * Register a callback fired when any stream's follow-up queue is released.
   * Returns an unsubscribe function. Used by async event sources (e.g. PR
   * polling) to tear down stream-scoped subscriptions when the owning stream
   * goes away.
   */
  static onRelease(observer: (streamId: StreamTabId) => void): () => void {
    this.releaseObservers.add(observer);
    return () => {
      this.releaseObservers.delete(observer);
    };
  }

  static acquire(streamId: StreamTabId): FollowUpQueue {
    this.released.delete(streamId);
    const existing = this.queues.get(streamId);
    if (existing) return existing;
    const queue = new FollowUpQueue();
    this.queues.set(streamId, queue);
    return queue;
  }

  static release(streamId: StreamTabId): void {
    const queue = this.queues.get(streamId);
    if (queue) {
      queue.dispose();
      this.queues.delete(streamId);
    }
    this.released.add(streamId);
    if (this.released.size > this.RELEASED_CAP) {
      this.released.clear();
      this.released.add(streamId);
    }
    logger.debug(`Released follow-up queue for stream ${streamId}.`);
    for (const observer of this.releaseObservers) {
      try {
        observer(streamId);
      } catch (err) {
        logger.warn(
          `Release observer threw for stream ${streamId}: ${String(err)}`,
        );
      }
    }
  }

  /**
   * Check if a stream is currently resuming.
   * Uses StreamStatusService as the single source of truth.
   */
  static isResuming(streamId: StreamTabId): boolean {
    return StreamStatusService.get(streamId) === STREAM_STATUS.RESUMING;
  }

  /**
   * Enqueue a follow-up for a stream.
   *
   * Auto-creates the queue if it doesn't exist yet (needed for WAITING streams
   * from prior sessions). Returns false and silently discards if the queue was
   * explicitly released (orchestrator disposed — late-arriving subagent
   * results). Pass `{ force: true }` for explicit user actions that should
   * reopen a released queue (caller is responsible for ensuring a consumer
   * will drain it, or releasing again on failure).
   */
  static enqueue(
    streamId: StreamTabId,
    followUp: string,
    options?: { force?: boolean },
  ): boolean {
    if (this.released.has(streamId) && !options?.force) {
      logger.debug(
        `Queue for stream ${streamId} was released, discarding follow-up.`,
      );
      return false;
    }
    const queue = this.acquire(streamId);
    queue.enqueue(followUp);
    logger.debug(`Queued follow-up for stream ${streamId}.`);
    return true;
  }

  static drain(streamId: StreamTabId): string[] {
    return this.queues.get(streamId)?.drain() ?? [];
  }

  /** Get all queued follow-up messages for a stream without consuming them. */
  static getAll(streamId: StreamTabId): string[] {
    return this.queues.get(streamId)?.getAll() ?? [];
  }
}
