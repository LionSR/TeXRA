import { LRUCache } from 'lru-cache';
import { createChannelTrace } from '@agent/trace';
import type { RecoveryContinuation } from '@platform/interfaces';
import type { StreamTabId } from '@shared/schemas';
import {
  createBoundedIdSet,
  type BoundedIdSet,
} from '@utils/core/boundedIdSet';
import {
  FollowUpQueue,
  type DrainedFollowUpItem,
  type FollowUpQueueInput,
} from './FollowUpQueue';

// Hosts reach the queue input shape through this module (ratchet-baselined
// import specifier); FollowUpQueue.ts stays agent-internal.
export type { FollowUpQueueInput } from './FollowUpQueue';

const logger = createChannelTrace('ToolUseFollowUpQueue');

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
  generation: number;
  owner?: FollowUpConsumerLease;
}

/**
 * Exclusive authority to consume one stream's follow-up queue.
 *
 * The manager issues at most one lease per entry. Claims and releases are
 * synchronous, and every lease carries the entry generation it claimed. A
 * release from an older flow/child therefore cannot clear or terminalize a
 * successor recovery generation. Only the lease may wait, drain, or dispose;
 * producers submit through the manager and cannot manufacture a consumer.
 */
export interface FollowUpConsumerLease {
  readonly streamId: StreamTabId;
  readonly generation: number;
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
 * persisted cursor is `recoverable`, and terminal stream ids are retained in a
 * bounded tombstone cache. Terminal entries cannot be reopened.
 */
export class ToolUseFollowUpQueue {
  static readonly TERMINAL_CAP = 500;
  static readonly DELIVERY_ID_CAP = 1000;
  private readonly entries = new Map<StreamTabId, QueueEntry>();
  private readonly terminal = new LRUCache<StreamTabId, true>({
    max: ToolUseFollowUpQueue.TERMINAL_CAP,
  });
  private readonly releaseObservers = new Set<
    (streamId: StreamTabId) => void
  >();

  onRelease(observer: (streamId: StreamTabId) => void): () => void {
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
    if (this.terminal.has(streamId)) return undefined;
    const entry = this.entries.get(streamId) ?? this.createEntry(streamId);
    return this.claim(entry, streamId, kind);
  }

  /** Claim persisted recovery before any asynchronous resume preparation. */
  claimRecovery(
    streamId: StreamTabId,
    createIfMissing = false,
  ): FollowUpRecoveryLease | undefined {
    if (this.terminal.has(streamId)) return undefined;
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
   * queue when needed. `existing_recoverable` admits only an already-retained
   * recoverable queue, which lets a final child result survive child untracking
   * without reopening an otherwise terminal parent.
   */
  submit(
    streamId: StreamTabId,
    followUp: FollowUpQueueInput,
    admission: 'live_owner' | 'recoverable' | 'existing_recoverable',
  ): FollowUpSubmission {
    if (this.terminal.has(streamId)) return { kind: 'unavailable' };

    let entry = this.entries.get(streamId);
    if (admission === 'live_owner') {
      if (!entry) return { kind: 'not_owned' };
    } else {
      if (!entry && admission === 'existing_recoverable') {
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

  /** Restore a failed recovery batch ahead of submissions that raced it. */
  restore(
    lease: FollowUpRecoveryLease,
    followUps: readonly FollowUpQueueInput[],
  ): void {
    this.requireOwner(lease).queue.restore(followUps);
  }

  /** Read-only lifecycle probe used by diagnostics and teardown assertions. */
  hasLiveOwner(streamId: StreamTabId): boolean {
    const owner = this.entries.get(streamId)?.owner;
    return owner?.kind === 'flow' || owner?.kind === 'child';
  }

  /** Inner child/recovery flows borrow the queue their outer owner consumes. */
  externallyOwnedQueue(streamId: StreamTabId): FollowUpQueue | undefined {
    const entry = this.entries.get(streamId);
    return entry?.owner?.kind === 'child' || entry?.owner?.kind === 'recovery'
      ? entry.queue
      : undefined;
  }

  queue(lease: FollowUpConsumerLease): FollowUpQueue {
    return this.requireOwner(lease).queue;
  }

  drainItems(lease: FollowUpConsumerLease): DrainedFollowUpItem[] {
    return this.requireOwner(lease).queue.drainItems();
  }

  /**
   * Release only the generation represented by `lease`. `recoverable` keeps
   * queued data for a successor claim; `terminal` disposes it permanently.
   */
  release(
    lease: FollowUpConsumerLease,
    next: 'recoverable' | 'terminal',
  ): boolean {
    const entry = this.entries.get(lease.streamId);
    if (
      !entry ||
      entry.owner !== lease ||
      entry.generation !== lease.generation
    ) {
      return false;
    }
    entry.owner = undefined;
    if (next === 'recoverable') {
      entry.lifecycle = 'recoverable';
      return true;
    }
    entry.queue.dispose();
    this.entries.delete(lease.streamId);
    this.terminal.set(lease.streamId, true);
    logger.debug(`Terminalized follow-up queue for stream ${lease.streamId}.`);
    this.notifyReleaseObservers(lease.streamId);
    return true;
  }

  /** Terminalize a stream; any outstanding lease becomes stale immediately. */
  terminalize(streamId: StreamTabId): boolean {
    const entry = this.entries.get(streamId);
    entry?.queue.dispose();
    this.entries.delete(streamId);
    this.terminal.set(streamId, true);
    this.notifyReleaseObservers(streamId);
    return true;
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
      generation: 0,
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
    entry.generation += 1;
    const lease: FollowUpConsumerLease = {
      streamId,
      generation: entry.generation,
      kind,
    };
    entry.owner = lease;
    entry.lifecycle = kind === 'recovery' ? 'recovering' : 'live';
    return lease;
  }

  private requireOwner(lease: FollowUpConsumerLease): QueueEntry {
    const entry = this.entries.get(lease.streamId);
    if (
      !entry ||
      entry.owner !== lease ||
      entry.generation !== lease.generation
    ) {
      throw new Error(
        `Follow-up consumer lease is stale for stream ${lease.streamId}.`,
      );
    }
    return entry;
  }
}
