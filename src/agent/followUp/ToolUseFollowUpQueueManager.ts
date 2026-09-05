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

type FollowUpConsumerKind = 'flow' | 'child' | 'recovery';

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
  /** At most one consumer; an unowned entry is a recoverable persisted cursor. */
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

/**
 * How one submission landed: a replayed delivery id, input a live flow
 * consumer will read this turn, input parked on the stream's queue (with the
 * recovery lease when this submission claimed it), or a refusal — the
 * boundary has no entry to join and will not create one (disposed session,
 * terminalized stream, or a live-owner submission to a stream whose entry is
 * gone).
 */
type FollowUpSubmission =
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'delivered_live' }
  | { readonly kind: 'queued'; readonly lease?: FollowUpRecoveryLease }
  | { readonly kind: 'refused' };

/**
 * Session-owned continuation boundary indexed by stream ID.
 *
 * An owned entry has a live or recovering consumer, an unowned entry is a
 * recoverable persisted cursor, and a terminal entry is gone. A stream
 * whose queue was ended by {@link terminalize} (its stream deleted, or its
 * parked run torn down) is marked so that a producer that is not an owner,
 * such as a child whose activation outlives its parent's teardown, cannot
 * recreate the queue and trigger a resume of a run that is gone; only an
 * explicit claim reopens the stream. Stream ids embed their execution id, so
 * the mark never collides with a later run. Tombstones are bounded; after
 * eviction, callers must revalidate persisted authority before recoverable
 * admission.
 */
export class ToolUseFollowUpQueue {
  static readonly DELIVERY_ID_CAP = 1000;
  static readonly TERMINALIZED_CAP = 500;
  private readonly entries = new Map<StreamTabId, QueueEntry>();
  private readonly terminalized = createBoundedIdSet<StreamTabId>(
    ToolUseFollowUpQueue.TERMINALIZED_CAP,
  );
  private readonly releaseObservers = new Set<
    (streamId: StreamTabId) => void
  >();
  private readonly sentObservers = new Set<(streamId: StreamTabId) => void>();
  private disposed = false;

  onRelease(observer: (streamId: StreamTabId) => void): () => void {
    if (this.disposed) return () => {};
    this.releaseObservers.add(observer);
    return () => {
      this.releaseObservers.delete(observer);
    };
  }

  /**
   * Observe input reaching a stream's live consumer (a follow-up delivered
   * live, a compaction request queued for the next model call). An
   * occurrence, not state: it is what `executions wait` ends its wait on,
   * and it lives in this process only, never on the session's event plane.
   */
  onSent(observer: (streamId: StreamTabId) => void): () => void {
    if (this.disposed) return () => {};
    this.sentObservers.add(observer);
    return () => {
      this.sentObservers.delete(observer);
    };
  }

  notifySent(streamId: StreamTabId): void {
    for (const observer of [...this.sentObservers]) observer(streamId);
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
    const entry = this.entries.get(streamId) ?? this.createEntry(streamId);
    return this.claim(entry, streamId, 'child');
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
    if (!entry || entry.owner) return undefined;
    return this.claim(entry, streamId, 'recovery');
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
    if (this.disposed) return { kind: 'refused' };

    let entry = this.entries.get(streamId);
    if (admission === 'live_owner') {
      if (!entry) return { kind: 'refused' };
    } else {
      if (!entry && this.terminalized.has(streamId)) {
        return { kind: 'refused' };
      }
      entry ??= this.createEntry(streamId);
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
    if (owner?.kind === 'flow') return { kind: 'delivered_live' };
    // Live notifications use the live_owner path to reach WAITING parents
    // whose retained queue will be consumed when the stream resumes.
    if (owner !== undefined || admission === 'live_owner') {
      return { kind: 'queued' };
    }

    const lease = this.claim(entry, streamId, 'recovery');
    return lease ? { kind: 'queued', lease } : { kind: 'queued' };
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
    if (next === 'recoverable') return true;
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
    };
    this.entries.set(streamId, entry);
    return entry;
  }

  /**
   * Mint the entry's single lease. Generic over the consumer kind so a
   * `'recovery'` claim yields a {@link FollowUpRecoveryLease} by construction,
   * rather than a widened lease each caller has to assert back down.
   */
  private claim<K extends FollowUpConsumerKind>(
    entry: QueueEntry,
    streamId: StreamTabId,
    kind: K,
  ): (FollowUpConsumerLease & { readonly kind: K }) | undefined {
    if (entry.owner) return undefined;
    const lease: FollowUpConsumerLease & { readonly kind: K } = {
      streamId,
      kind,
    };
    entry.owner = lease;
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
