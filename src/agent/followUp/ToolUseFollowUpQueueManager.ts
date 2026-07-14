import { LRUCache } from 'lru-cache';
import { createChannelTrace } from '@agent/trace';
import type { StreamTabId } from '@shared/schemas';
import {
  FollowUpQueue,
  type DrainedFollowUpItem,
  type FollowUpQueueInput,
} from './FollowUpQueue';

const logger = createChannelTrace('ToolUseFollowUpQueue');

/**
 * Follow-up queue owner indexed by stream ID.
 *
 * Every instance is session-owned — the process default lives at
 * `defaultSession().followUps` (#7694); there is no separate static/module
 * singleton to reach it through.
 */
export class ToolUseFollowUpQueue {
  static readonly RELEASED_CAP = 500;
  private readonly queues = new Map<StreamTabId, FollowUpQueue>();
  /** Streams whose queues were explicitly released (orchestrator disposed). */
  private readonly released = new LRUCache<StreamTabId, true>({
    max: ToolUseFollowUpQueue.RELEASED_CAP,
  });
  /** Observers notified whenever a stream's queue is released. */
  private readonly releaseObservers = new Set<
    (streamId: StreamTabId) => void
  >();

  /**
   * Register a callback fired when any stream's follow-up queue is released.
   * Returns an unsubscribe function. Used by async event sources (e.g. PR
   * polling) to tear down stream-scoped subscriptions when the owning stream
   * goes away.
   */
  onRelease(observer: (streamId: StreamTabId) => void): () => void {
    this.releaseObservers.add(observer);
    return () => {
      this.releaseObservers.delete(observer);
    };
  }

  acquire(streamId: StreamTabId): FollowUpQueue {
    this.released.delete(streamId);
    const existing = this.queues.get(streamId);
    if (existing) return existing;
    const queue = new FollowUpQueue();
    this.queues.set(streamId, queue);
    return queue;
  }

  release(streamId: StreamTabId): void {
    const queue = this.queues.get(streamId);
    if (queue) {
      queue.dispose();
      this.queues.delete(streamId);
    }
    this.rememberReleased(streamId);
    logger.debug(`Released follow-up queue for stream ${streamId}.`);
    for (const observer of this.releaseObservers) {
      try {
        observer(streamId);
      } catch (err) {
        logger.warn(`Release observer threw for stream ${streamId}`, {
          data: err,
        });
      }
    }
  }

  /**
   * Enqueue a follow-up for a stream.
   *
   * Auto-creates the queue if it doesn't exist yet (needed for WAITING streams
   * from prior sessions) only when the caller has already admitted the
   * follow-up through the registry. Returns false and silently discards if the queue was
   * explicitly released (orchestrator disposed — late-arriving subagent
   * results). Pass `{ force: true }` for explicit user actions that should
   * reopen or create a queue even without `createIfMissing` (caller is
   * responsible for ensuring a consumer will drain it, or releasing again on
   * failure).
   */
  enqueue(
    streamId: StreamTabId,
    followUp: FollowUpQueueInput,
    options?: { createIfMissing?: boolean; force?: boolean },
  ): boolean {
    if (this.released.has(streamId) && !options?.force) {
      logger.debug(
        `Queue for stream ${streamId} was released, discarding follow-up.`,
      );
      return false;
    }
    const queue = this.queues.get(streamId);
    if (!queue && !options?.createIfMissing && !options?.force) {
      logger.debug(
        `No follow-up queue for stream ${streamId}, discarding follow-up.`,
      );
      return false;
    }
    const target = queue ?? this.acquire(streamId);
    target.enqueue(followUp);
    logger.debug(`Queued follow-up for stream ${streamId}.`);
    return true;
  }

  drain(streamId: StreamTabId): string[] {
    return this.queues.get(streamId)?.drain() ?? [];
  }

  /** Drain queued follow-ups with their media file paths (resume replay). */
  drainItems(streamId: StreamTabId): DrainedFollowUpItem[] {
    return this.queues.get(streamId)?.drainItems() ?? [];
  }

  /** Get all queued follow-up messages for a stream without consuming them. */
  getAll(streamId: StreamTabId): string[] {
    return this.queues.get(streamId)?.getAll() ?? [];
  }

  private rememberReleased(streamId: StreamTabId): void {
    this.released.set(streamId, true);
  }
}
