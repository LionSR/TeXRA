/**
 * Promise-based queue for follow-up messages in a tool-use session.
 *
 * This is a standalone data structure with no dependencies on other
 * toolUse modules, allowing it to be imported without circular dependency issues.
 */
import pDefer, { type DeferredPromise } from 'p-defer';

import { onAbort } from '@utils/core';

/** Preserves visible follow-up provenance across queueing and resume replay. */
type VisibleFollowUpQueueItemOrigin = 'user' | 'subagent_result';
type FollowUpQueueItemOrigin = VisibleFollowUpQueueItemOrigin | 'synthetic';

export interface FollowUpQueueInput {
  readonly text: string;
  readonly displayText?: string;
  /** Media file paths (e.g. pasted images) attached to this user follow-up. */
  readonly mediaFiles?: readonly string[];
  readonly origin?: VisibleFollowUpQueueItemOrigin;
  /**
   * Stable logical identity of one child-run result delivery (#9531). The
   * admission boundary suppresses replays of an id it already admitted;
   * inputs without one are never suppressed.
   */
  readonly deliveryId?: string;
}

interface FollowUpQueueItem extends Omit<FollowUpQueueInput, 'origin'> {
  readonly origin: FollowUpQueueItemOrigin;
}

/** A queued follow-up surfaced in a drained batch; same shape as the stored item. */
export type FollowUpQueueBatchItem = FollowUpQueueItem;

/** A single visible follow-up drained for resume replay. */
export type DrainedFollowUpItem = FollowUpQueueItem & {
  readonly origin: VisibleFollowUpQueueItemOrigin;
};

export interface FollowUpQueueBatch {
  readonly items: FollowUpQueueBatchItem[];
  readonly synthetic: boolean;
}

function displayTextForItem(item: FollowUpQueueItem): string {
  return item.displayText ?? item.text;
}

function isVisibleItem(item: FollowUpQueueItem): item is DrainedFollowUpItem {
  return item.origin !== 'synthetic';
}

export class FollowUpQueue {
  private readonly queued: FollowUpQueueItem[] = [];
  private deferred: DeferredPromise<FollowUpQueueItem | null> | null = null;

  enqueue(value: FollowUpQueueInput): void {
    this.enqueueItem(this.toItem(value));
  }

  /** Restore a drained visible batch ahead of input that raced its consumer. */
  restore(values: readonly FollowUpQueueInput[]): void {
    this.queued.unshift(...values.map((value) => this.toItem(value)));
  }

  enqueueSynthetic(value: string): void {
    this.enqueueItem({ text: value, origin: 'synthetic' });
  }

  private enqueueItem(value: FollowUpQueueItem): void {
    if (this.deferred) {
      const d = this.deferred;
      this.deferred = null;
      d.resolve(value);
    } else {
      this.queued.push(value);
    }
  }

  private toItem(value: FollowUpQueueInput): FollowUpQueueItem {
    return {
      text: value.text,
      displayText: value.displayText,
      origin: value.origin ?? 'user',
      mediaFiles: value.mediaFiles,
      deliveryId: value.deliveryId,
    };
  }

  isEmpty(): boolean {
    return this.queued.length === 0;
  }

  /**
   * Drain queued visible follow-ups together with their media file paths.
   * Used by resume to replay queued user input without losing pasted images.
   */
  drainItems(): DrainedFollowUpItem[] {
    return this.queued.splice(0).filter(isVisibleItem);
  }

  waitForNext(signal: AbortSignal): Promise<FollowUpQueueItem | null> {
    const next = this.queued.shift();
    if (next) {
      return Promise.resolve(next);
    }
    if (signal.aborted) {
      return Promise.resolve(null);
    }
    if (this.deferred) {
      throw new Error('Follow-up queue already has a waiting consumer.');
    }
    const d = pDefer<FollowUpQueueItem | null>();
    this.deferred = d;
    const detach = onAbort(signal, () => {
      if (this.deferred !== d) return;
      this.deferred = null;
      d.resolve(null);
    });
    return d.promise.finally(detach);
  }

  /**
   * Wait for at least one item, then drain one batch.
   * Batches never mix synthetic and visible items: a synthetic batch drains
   * the contiguous run of queued synthetic items (back-to-back maintenance
   * turns coalesce into one model turn instead of one turn each), and
   * visible batches stop at the next synthetic boundary so hidden
   * maintenance turns do not merge with user text.
   * Returns null if interrupted.
   */
  async waitAndDrainAll(
    signal: AbortSignal,
  ): Promise<FollowUpQueueBatch | null> {
    const first = await this.waitForNext(signal);
    if (first === null) return null;
    const synthetic = first.origin === 'synthetic';

    const items: FollowUpQueueBatchItem[] = [first];
    while (true) {
      const next = this.queued[0];
      if (!next || (next.origin === 'synthetic') !== synthetic) break;
      items.push(this.queued.shift()!);
    }
    return { items, synthetic };
  }

  cancelWait(): void {
    const d = this.deferred;
    this.deferred = null;
    d?.resolve(null);
  }

  dispose(): void {
    this.cancelWait();
    this.queued.length = 0;
  }

  /** Get a copy of all queued items for display purposes. */
  getAll(): string[] {
    return this.queued.filter(isVisibleItem).map(displayTextForItem);
  }
}
