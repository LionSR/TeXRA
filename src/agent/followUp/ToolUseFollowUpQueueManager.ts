import { createLog } from '@logger/logUtils';
import type { RecoveryContinuation } from '@platform/interfaces';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { throwAggregated } from '@utils/core';
import {
  createBoundedIdSet,
  type BoundedIdSet,
} from '@utils/core/boundedIdSet';
import { FollowUpQueue, type FollowUpQueueInput } from './FollowUpQueue';

const logger = createLog('ToolUseFollowUpQueue');

type QueueLifecycle = 'live' | 'recoverable' | 'recovering';
export type FollowUpConsumerKind = 'flow' | 'child' | 'recovery';

interface QueueEntry {
  readonly queue: FollowUpQueue;
  /**
   * Delivery ids already admitted for this stream (#9531). In-memory,
   * transport-level replay suppression only — NOT crash-safe exactly-once: a
   * restart (or LRU eviction past the cap) forgets admitted ids, so a replay
   * after that is admitted again. An outbox/idempotent parent inbox is
   * deferred until crash/restart tests reproduce duplicate or lost insertion.
   */
  readonly admittedDeliveryIds: BoundedIdSet<string>;
  lifecycle: QueueLifecycle;
  owner?: FollowUpConsumerLease;
}

/**
 * Exclusive authority to consume one stream's follow-up queue.
 *
 * The manager issues at most one lease per entry. Claims and releases are
 * synchronous, and a lease is valid only while it is the entry's owner, so a
 * release from an older flow/child cannot clear or terminalize a successor.
 * Only the lease may wait, drain, or dispose; producers submit through the
 * manager and cannot manufacture a consumer.
 */
export interface FollowUpConsumerLease {
  readonly streamId: StreamTabId;
  readonly kind: FollowUpConsumerKind;
}

export interface FollowUpRecoveryLease
  extends FollowUpConsumerLease, RecoveryContinuation {
  readonly kind: 'recovery';
}

export type FollowUpSubmission =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'not_owned' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'queued' }
  | { readonly kind: 'live' }
  | { readonly kind: 'live_flow' }
  | { readonly kind: 'recovering' }
  | { readonly kind: 'recovery'; readonly lease: FollowUpRecoveryLease };

/**
 * Session-owned continuation boundary indexed by stream ID.
 *
 * Lifecycle is explicit: an owned entry is `live` or `recovering`, an unowned
 * persisted cursor is `recoverable`, and a terminal entry is gone. A stream
 * whose queue was ended by {@link terminalize} (its stream deleted, or its
 * parked run torn down) is marked so that a producer that is not an owner,
 * such as a child whose activation outlives its parent's teardown, cannot
 * recreate the queue and trigger a resume of a run that is gone; only an
 * explicit claim reopens the stream. Stream ids embed their execution id, so
 * the mark never collides with a later run, and a session accrues one per
 * ended stream.
 */
export class ToolUseFollowUpQueue {
  static readonly DELIVERY_ID_CAP = 1000;
  private readonly entries = new Map<StreamTabId, QueueEntry>();
  private readonly terminalized = new Set<StreamTabId>();
  private readonly releaseObservers = new Set<
    (streamId: StreamTabId) => void
  >();
  private disposed = false;

  onRelease(observer: (streamId: StreamTabId) => void): () => void {
    if (this.disposed) return () => {};
    this.releaseObservers.add(observer);
    return () => {
      this.releaseObservers.delete(observer);
    };
  }

  /** Claim a live flow/child consumer. A competing owner is rejected. */
  claimLive(
    streamId: StreamTabId,
    kind: Exclude<FollowUpConsumerKind, 'recovery'>,
  ): FollowUpConsumerLease | undefined {
    if (this.disposed) return undefined;
    this.terminalized.delete(streamId);
    const entry = this.entries.get(streamId) ?? this.createEntry(streamId);
    return this.claim(entry, streamId, kind);
  }

  /**
   * Begin a separately authorized child run. The caller must already own the
   * execution lease.
   */
  claimChildRun(
    streamId: StreamTabId,
    executionId: ExecutionId,
  ): FollowUpConsumerLease | undefined {
    if (this.disposed) return undefined;
    if (!streamId.endsWith(`#${executionId}`)) {
      throw new Error(
        `Child stream ${streamId} does not belong to execution ${executionId}.`,
      );
    }
    this.terminalized.delete(streamId);
    const retained = this.entries.get(streamId);
    if (retained) return this.claim(retained, streamId, 'child');
    return this.claim(this.createEntry(streamId), streamId, 'child');
  }

  /** Claim persisted recovery before any asynchronous resume preparation. */
  claimRecovery(
    streamId: StreamTabId,
    createIfMissing = false,
  ): FollowUpRecoveryLease | undefined {
    if (this.disposed) return undefined;
    if (createIfMissing) this.terminalized.delete(streamId);
    const entry =
      this.entries.get(streamId) ??
      (createIfMissing ? this.createEntry(streamId) : undefined);
    if (!entry || entry.lifecycle !== 'recoverable' || entry.owner) {
      return undefined;
    }
    return this.claim(entry, streamId, 'recovery') as FollowUpRecoveryLease;
  }

  useRecovery(
    recovery: RecoveryContinuation,
  ): FollowUpRecoveryLease | undefined {
    const entry = this.entries.get(recovery.streamId);
    return entry?.owner === recovery && recovery.kind === 'recovery'
      ? (entry.owner as FollowUpRecoveryLease)
      : undefined;
  }

  /**
   * Submit through the queue's ownership boundary. `live_owner` joins a live
   * flow or child consumer, or enqueues without claiming when the entry has no
   * live owner (so live notifications can reach a WAITING parent queue).
   * `recoverable` admits a registry-approved persisted cursor and creates its
   * queue when needed.
   */
  submit(
    streamId: StreamTabId,
    followUp: FollowUpQueueInput,
    admission: 'live_owner' | 'recoverable',
  ): FollowUpSubmission {
    if (this.disposed) return { kind: 'unavailable' };

    let entry = this.entries.get(streamId);
    if (admission === 'live_owner') {
      if (!entry) return { kind: 'not_owned' };
    } else {
      if (!entry && this.terminalized.has(streamId)) {
        return { kind: 'unavailable' };
      }
      entry ??= this.createEntry(streamId);
      if (!entry.owner) entry.lifecycle = 'recoverable';
    }

    // Replay suppression is synchronous check-and-add: concurrent submissions
    // of one delivery id admit at most once (#9531). Ids are minted by the
    // child-run loop per accepted turn; identical text under a distinct id is
    // a distinct delivery.
    const deliveryId = followUp.deliveryId;
    if (deliveryId !== undefined) {
      if (entry.admittedDeliveryIds.has(deliveryId)) {
        return { kind: 'duplicate' };
      }
      entry.admittedDeliveryIds.add(deliveryId);
    }

    entry.queue.enqueue(followUp);
    logger.debug(`Queued follow-up for stream ${streamId}.`);
    const owner = entry.owner;
    if (owner?.kind === 'flow') return { kind: 'live_flow' };
    if (owner?.kind === 'child') return { kind: 'live' };
    if (owner?.kind === 'recovery') return { kind: 'recovering' };

    if (admission === 'live_owner') {
      // Live notifications use this path to reach WAITING parents whose
      // retained queue will be consumed when the stream resumes.
      return { kind: 'queued' };
    }

    const lease = this.claim(entry, streamId, 'recovery');
    if (!lease) return { kind: 'recovering' };
    return { kind: 'recovery', lease: lease as FollowUpRecoveryLease };
  }

  /** Read-only lifecycle probe used by diagnostics and teardown assertions. */
  hasLiveOwner(streamId: StreamTabId): boolean {
    const owner = this.entries.get(streamId)?.owner;
    return owner?.kind === 'flow' || owner?.kind === 'child';
  }

  /** Inner child/recovery flows borrow the queue their outer owner consumes. */
  externallyOwnedQueue(streamId: StreamTabId): FollowUpQueue | undefined {
    const entry = this.entries.get(streamId);
    const kind = entry?.owner?.kind;
    return kind === 'child' || kind === 'recovery' ? entry?.queue : undefined;
  }

  queue(lease: FollowUpConsumerLease): FollowUpQueue {
    return this.requireOwner(lease).queue;
  }

  /**
   * Release the entry `lease` owns, if it still does. `recoverable` keeps
   * queued data for a successor claim; `terminal` disposes it permanently.
   */
  release(
    lease: FollowUpConsumerLease,
    next: 'recoverable' | 'terminal',
  ): boolean {
    const entry = this.entryForLease(lease);
    if (!entry) return false;
    entry.owner = undefined;
    if (next === 'recoverable') {
      entry.lifecycle = 'recoverable';
      return true;
    }
    entry.queue.dispose();
    this.entries.delete(lease.streamId);
    logger.debug(`Terminalized follow-up queue for stream ${lease.streamId}.`);
    this.notifyReleaseObservers(lease.streamId);
    return true;
  }

  /**
   * End a stream's queue: any outstanding lease becomes stale immediately, and
   * no producer can recreate the queue until an explicit claim reopens it.
   */
  terminalize(streamId: StreamTabId): boolean {
    if (this.disposed) return false;
    const entry = this.entries.get(streamId);
    entry?.queue.dispose();
    this.entries.delete(streamId);
    this.terminalized.add(streamId);
    this.notifyReleaseObservers(streamId);
    return true;
  }

  /**
   * Dispose the session-owned boundary: every live entry queue, then the
   * entry map and release observers. The state clears in a `finally` so one
   * queue's disposal failure cannot leave the map or observers behind.
   * Entry-creating paths refuse to rebuild afterwards, so a late detached
   * producer cannot leak a queue nobody will drain.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const failures: unknown[] = [];
    try {
      for (const entry of this.entries.values()) {
        try {
          entry.queue.dispose();
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      this.entries.clear();
      this.terminalized.clear();
      this.releaseObservers.clear();
    }
    throwAggregated(failures, 'Multiple follow-up queues failed to dispose');
  }

  private notifyReleaseObservers(streamId: StreamTabId): void {
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

  /** Presentation-only snapshot; does not grant consumption rights. */
  getAll(streamId: StreamTabId): string[] {
    return this.entries.get(streamId)?.queue.getAll() ?? [];
  }

  private createEntry(streamId: StreamTabId): QueueEntry {
    const entry: QueueEntry = {
      queue: new FollowUpQueue(),
      admittedDeliveryIds: createBoundedIdSet(
        ToolUseFollowUpQueue.DELIVERY_ID_CAP,
      ),
      lifecycle: 'recoverable',
    };
    this.entries.set(streamId, entry);
    return entry;
  }

  private claim(
    entry: QueueEntry,
    streamId: StreamTabId,
    kind: FollowUpConsumerKind,
  ): FollowUpConsumerLease | undefined {
    if (entry.owner) return undefined;
    const lease: FollowUpConsumerLease = { streamId, kind };
    entry.owner = lease;
    entry.lifecycle = kind === 'recovery' ? 'recovering' : 'live';
    return lease;
  }

  private requireOwner(lease: FollowUpConsumerLease): QueueEntry {
    const entry = this.entryForLease(lease);
    if (!entry) {
      throw new Error(
        `Follow-up consumer lease is stale for stream ${lease.streamId}.`,
      );
    }
    return entry;
  }

  /** The entry `lease` still owns, or `undefined` if it has gone stale. */
  private entryForLease(lease: FollowUpConsumerLease): QueueEntry | undefined {
    const entry = this.entries.get(lease.streamId);
    return entry?.owner === lease ? entry : undefined;
  }
}
