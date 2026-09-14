import { randomUUID } from 'node:crypto';

import { createLog } from '@logger/logUtils';
import type { RecoveryContinuation } from '@platform/interfaces';
import {
  aggregateId,
  type FollowUpContent,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import {
  createBoundedIdSet,
  type BoundedIdSet,
} from '@utils/core/boundedIdSet';
import type { QueuedFollowUp, RunInput } from './RunInput';

const logger = createLog('ToolUseFollowUpQueue');

/** What a producer hands the admission boundary. */
export interface FollowUpQueueInput {
  readonly text: string;
  readonly displayText?: string;
  /** Media file paths (e.g. pasted images) attached to this user follow-up. */
  readonly mediaFiles?: readonly string[];
  readonly origin?: FollowUpContent['origin'];
  /**
   * Stable logical identity of one delivery its producer may repeat: a
   * child-run result (#9531), an inquiry continuation re-delivered after a
   * decision that failed before the queue saw it. It becomes the queued
   * row's `followUpId`, and the admission boundary suppresses replays of an
   * id it already admitted; inputs without one get a minted id and are never
   * suppressed.
   */
  readonly deliveryId?: string;
}

type FollowUpConsumerKind = 'flow' | 'child' | 'recovery';

interface QueueEntry {
  /**
   * Delivery ids already admitted for this run (#9531). In-memory,
   * transport-level replay suppression only: a restart (or LRU eviction past
   * the cap) forgets admitted ids, so a replay after that is admitted again.
   */
  readonly admittedDeliveryIds: BoundedIdSet<string>;
  /** At most one consumer; an unowned entry is a recoverable persisted run. */
  owner?: FollowUpConsumerLease;
  /**
   * The owner's input queue, once its consumer attached one. Before that,
   * the follow-ups committed since the claim wait in `held`, so the queue
   * the consumer seeds from the fold still receives them after the rows
   * the fold already holds.
   */
  input?: RunInput;
  held: QueuedFollowUp[];
}

/**
 * Exclusive authority to consume one run's follow-up input.
 *
 * The manager issues at most one lease per entry. Claims and releases are
 * synchronous, and a lease is valid only while it is the entry's owner, so a
 * release from an older flow/child cannot clear or terminalize a successor.
 * Producers submit through the manager and cannot manufacture a consumer.
 */
export interface FollowUpConsumerLease {
  readonly runId: RunId;
  readonly kind: FollowUpConsumerKind;
}

export interface FollowUpRecoveryLease
  extends FollowUpConsumerLease, RecoveryContinuation {
  readonly kind: 'recovery';
}

/**
 * How one submission landed: a replayed delivery id, input a live flow
 * consumer will read this turn, input queued on the run (with the recovery
 * lease when this submission claimed it), or a refusal — the boundary has
 * no entry to join and will not create one (disposed session, terminalized
 * run, or a live-owner submission to a run whose entry is gone).
 */
type FollowUpSubmission =
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'delivered_live' }
  | { readonly kind: 'queued'; readonly lease?: FollowUpRecoveryLease }
  | { readonly kind: 'refused' };

/**
 * Session-owned admission boundary indexed by run ID.
 *
 * An admitted follow-up is a `followup.queued` row on the run, published
 * through the session's one publisher at the moment of admission, so it
 * commits ahead of anything its consumer later appends. The row is the
 * input: an owned entry also hands it to its consumer's queue, and an
 * unowned run's next consumer seeds that queue from the fold.
 *
 * An owned entry has a live or recovering consumer, an unowned entry is a
 * recoverable persisted run, and a terminal entry is gone. A run whose
 * entry was ended by {@link terminalize} (its run deleted, or its parked
 * run torn down) is marked so that a producer that is not an owner, such as
 * a child whose activation outlives its parent's teardown, cannot recreate
 * the entry and trigger a resume of a run that is gone; only an explicit
 * claim reopens the run. Run ids are minted once per run, so the mark never
 * collides with a later run. Tombstones are bounded; after eviction,
 * callers must revalidate persisted authority before recoverable admission.
 */
export class ToolUseFollowUpQueue {
  static readonly DELIVERY_ID_CAP = 1000;
  static readonly TERMINALIZED_CAP = 500;
  private readonly entries = new Map<RunId, QueueEntry>();
  private readonly terminalized = createBoundedIdSet<RunId>(
    ToolUseFollowUpQueue.TERMINALIZED_CAP,
  );
  private readonly releaseObservers = new Set<(runId: RunId) => void>();
  private readonly sentObservers = new Set<(runId: RunId) => void>();
  private disposed = false;

  constructor(
    /** The session's ordered publisher (`SessionHandle.publish`). */
    private readonly publish: (events: readonly SessionEventDraft[]) => void,
  ) {}

  onRelease(observer: (runId: RunId) => void): () => void {
    if (this.disposed) return () => {};
    this.releaseObservers.add(observer);
    return () => {
      this.releaseObservers.delete(observer);
    };
  }

  /**
   * Observe input reaching a run's live consumer (a follow-up delivered
   * live, a compaction request queued for the next model call). An
   * occurrence, not state: it is what `executions wait` ends its wait on,
   * and it lives in this process only, never on the session's event plane.
   */
  onSent(observer: (runId: RunId) => void): () => void {
    if (this.disposed) return () => {};
    this.sentObservers.add(observer);
    return () => {
      this.sentObservers.delete(observer);
    };
  }

  notifySent(runId: RunId): void {
    for (const observer of [...this.sentObservers]) observer(runId);
  }

  /** Claim a live flow/child consumer. A competing owner is rejected. */
  claimLive(
    runId: RunId,
    kind: Exclude<FollowUpConsumerKind, 'recovery'>,
  ): FollowUpConsumerLease | undefined {
    if (this.disposed) return undefined;
    this.terminalized.delete(runId);
    const entry = this.entries.get(runId) ?? this.createEntry(runId);
    return this.claim(entry, runId, kind);
  }

  /**
   * Begin a separately authorized child run. The caller must already own the
   * run lease.
   */
  claimChildRun(runId: RunId): FollowUpConsumerLease | undefined {
    return this.claimLive(runId, 'child');
  }

  /** Claim persisted recovery before any asynchronous resume preparation. */
  claimRecovery(
    runId: RunId,
    createIfMissing = false,
  ): FollowUpRecoveryLease | undefined {
    if (this.disposed) return undefined;
    if (createIfMissing) this.terminalized.delete(runId);
    const entry =
      this.entries.get(runId) ??
      (createIfMissing ? this.createEntry(runId) : undefined);
    if (!entry || entry.owner) return undefined;
    return this.claim(entry, runId, 'recovery');
  }

  useRecovery(
    recovery: RecoveryContinuation,
  ): FollowUpRecoveryLease | undefined {
    const entry = this.entries.get(recovery.runId);
    return entry?.owner === recovery && recovery.kind === 'recovery'
      ? (entry.owner as FollowUpRecoveryLease)
      : undefined;
  }

  /**
   * Submit through the ownership boundary. `live_owner` joins a live flow or
   * child consumer, or queues without claiming when the entry has no live
   * owner (so live notifications can reach a WAITING parent). `recoverable`
   * admits a registry-approved persisted run and creates its entry when
   * needed.
   */
  submit(
    runId: RunId,
    followUp: FollowUpQueueInput,
    admission: 'live_owner' | 'recoverable',
  ): FollowUpSubmission {
    if (this.disposed) return { kind: 'refused' };

    let entry = this.entries.get(runId);
    if (admission === 'live_owner') {
      if (!entry) return { kind: 'refused' };
    } else {
      if (!entry && this.terminalized.has(runId)) {
        return { kind: 'refused' };
      }
      entry ??= this.createEntry(runId);
    }

    // Replay suppression is synchronous check-and-add: concurrent submissions
    // of one delivery id admit at most once (#9531). Ids are minted per
    // logical delivery by their producer (an accepted child-run turn, an
    // inquiry turn); identical text under a distinct id is a distinct
    // delivery.
    const deliveryId = followUp.deliveryId;
    if (deliveryId !== undefined) {
      if (entry.admittedDeliveryIds.has(deliveryId)) {
        return { kind: 'duplicate' };
      }
      entry.admittedDeliveryIds.add(deliveryId);
    }

    const owner = entry.owner;
    let submission: FollowUpSubmission;
    if (owner?.kind === 'flow') {
      submission = { kind: 'delivered_live' };
    } else if (owner !== undefined || admission === 'live_owner') {
      // Live notifications use the live_owner path to reach WAITING parents,
      // whose next consumer seeds its queue from the row.
      submission = { kind: 'queued' };
    } else {
      // The recovery claim precedes the row, so the input it admits is
      // already the recovering consumer's.
      const lease = this.claim(entry, runId, 'recovery');
      submission = lease ? { kind: 'queued', lease } : { kind: 'queued' };
    }
    this.queue(runId, entry, followUp);
    return submission;
  }

  /** Read-only lifecycle probe used by diagnostics and teardown assertions. */
  hasLiveOwner(runId: RunId): boolean {
    const owner = this.entries.get(runId)?.owner;
    return owner?.kind === 'flow' || owner?.kind === 'child';
  }

  /** Whether `lease`'s generation holds input its consumer has not taken. */
  hasQueued(lease: FollowUpConsumerLease): boolean {
    const entry = this.entryForLease(lease);
    if (!entry) return false;
    return entry.input ? entry.input.hasQueued() : entry.held.length > 0;
  }

  /**
   * Attach a consumer's input queue to the run's current owner and return the
   * queue it consumes: `lease`'s own entry, or, without a lease, the entry a
   * child or recovery owner holds (an inner loop reads the queue its outer
   * owner consumes). A queue already attached for this owner wins, so every
   * consumer of one generation reads one queue. `undefined` when there is no
   * such owner.
   */
  attachInput(
    runId: RunId,
    input: RunInput,
    lease?: FollowUpConsumerLease,
  ): RunInput | undefined {
    const entry = this.entries.get(runId);
    const owner = entry?.owner;
    if (!entry || !owner) return undefined;
    if (lease ? owner !== lease : owner.kind === 'flow') return undefined;
    if (entry.input) return entry.input;
    for (const followUp of entry.held) input.offer(followUp);
    entry.held = [];
    entry.input = input;
    return input;
  }

  /**
   * Release the entry `lease` owns, if it still does. Its input queue ends
   * either way: queued rows stay on the run for the next consumer to seed
   * from. `recoverable` keeps the entry for a successor claim; `terminal`
   * forgets it.
   */
  release(
    lease: FollowUpConsumerLease,
    next: 'recoverable' | 'terminal',
  ): boolean {
    const entry = this.entryForLease(lease);
    if (!entry) return false;
    entry.owner = undefined;
    this.endInput(entry);
    if (next === 'recoverable') return true;
    this.entries.delete(lease.runId);
    logger.debug(`Terminalized follow-up queue for run ${lease.runId}.`);
    this.notifyReleaseObservers(lease.runId);
    return true;
  }

  /**
   * End a run's entry: any outstanding lease becomes stale immediately, and
   * no producer can recreate the entry until an explicit claim reopens it.
   */
  terminalize(runId: RunId): boolean {
    if (this.disposed) return false;
    const entry = this.entries.get(runId);
    if (entry) this.endInput(entry);
    this.entries.delete(runId);
    this.terminalized.add(runId);
    this.notifyReleaseObservers(runId);
    return true;
  }

  /**
   * Dispose the session-owned boundary: end every attached queue, then drop
   * the entry map and release observers. Entry-creating paths refuse to
   * rebuild afterwards, so a late detached producer cannot leak an entry
   * nobody will drain.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) this.endInput(entry);
    this.entries.clear();
    this.terminalized.clear();
    this.releaseObservers.clear();
  }

  /**
   * Admit one follow-up as its row. Published on the session's one
   * publisher, the row takes its commit position now, ahead of any consume
   * batch its consumer appends later; a publication failure is logged by the
   * publisher as itself. An owned entry also hands the follow-up to its
   * consumer.
   */
  private queue(
    runId: RunId,
    entry: QueueEntry,
    input: FollowUpQueueInput,
  ): void {
    const followUp: QueuedFollowUp = {
      followUpId: input.deliveryId ?? randomUUID(),
      content: {
        text: input.text,
        displayText: input.displayText,
        mediaFiles: input.mediaFiles ? [...input.mediaFiles] : undefined,
        origin: input.origin ?? 'user',
      },
    };
    this.publish([
      {
        type: 'followup.queued',
        aggregateId: aggregateId('run', runId),
        ...followUp,
      },
    ]);
    logger.debug(`Queued follow-up for run ${runId}.`);
    if (!entry.owner) return;
    if (entry.input) entry.input.offer(followUp);
    else entry.held.push(followUp);
  }

  private endInput(entry: QueueEntry): void {
    entry.input?.end();
    entry.input = undefined;
    entry.held = [];
  }

  private notifyReleaseObservers(runId: RunId): void {
    for (const observer of this.releaseObservers) {
      try {
        observer(runId);
      } catch (err) {
        logger.warn(`Release observer threw for run ${runId}`, {
          data: err,
        });
      }
    }
  }

  private createEntry(runId: RunId): QueueEntry {
    const entry: QueueEntry = {
      admittedDeliveryIds: createBoundedIdSet(
        ToolUseFollowUpQueue.DELIVERY_ID_CAP,
      ),
      held: [],
    };
    this.entries.set(runId, entry);
    return entry;
  }

  /**
   * Mint the entry's single lease. Generic over the consumer kind so a
   * `'recovery'` claim yields a {@link FollowUpRecoveryLease} by construction,
   * rather than a widened lease each caller has to assert back down.
   */
  private claim<K extends FollowUpConsumerKind>(
    entry: QueueEntry,
    runId: RunId,
    kind: K,
  ): (FollowUpConsumerLease & { readonly kind: K }) | undefined {
    if (entry.owner) return undefined;
    const lease: FollowUpConsumerLease & { readonly kind: K } = {
      runId,
      kind,
    };
    entry.owner = lease;
    return lease;
  }

  /** The entry `lease` still owns, or `undefined` if it has gone stale. */
  private entryForLease(lease: FollowUpConsumerLease): QueueEntry | undefined {
    const entry = this.entries.get(lease.runId);
    return entry?.owner === lease ? entry : undefined;
  }
}
