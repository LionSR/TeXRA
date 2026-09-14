import { randomUUID } from 'node:crypto';

import { Effect, Exit, Result } from 'effect';

import { createLog } from '@logger/logUtils';
import type { RecoveryContinuation } from '@platform/interfaces';
import {
  aggregateId,
  type FollowUpContent,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import {
  DatabaseClaimRefused,
  DatabaseNotOwner,
  DatabaseWriteFailed,
} from '@shared/session/database';
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
 * How one submission landed, reported once its row is durable: a replayed
 * delivery id, input a live flow consumer will read this turn, input queued
 * on the run (with the recovery lease when this submission claimed it), or
 * a refusal. A refusal without a reason means the boundary has no entry to
 * join and will not create one (disposed session, terminalized run, or a
 * live-owner submission to a run whose entry is gone); `owned_elsewhere`
 * means another live process holds the run, so no row was written.
 */
type FollowUpSubmission =
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'delivered_live' }
  | { readonly kind: 'queued'; readonly lease?: FollowUpRecoveryLease }
  | { readonly kind: 'refused'; readonly reason?: 'owned_elsewhere' };

/** A `followup.queued` draft, as the admission boundary writes it. */
type FollowUpQueuedDraft = Extract<
  SessionEventDraft,
  { type: 'followup.queued' }
>;

/**
 * The session doors the admission boundary writes through, wired by
 * `SessionHandle` over its graph, so there is no second append path.
 */
export interface FollowUpRowPort {
  /**
   * The run aggregate's claim, acquired the way a resume acquires it (prior
   * owners proven dead first): returns the release of what this call took,
   * a no-op when the process already held it.
   */
  readonly acquireClaim: (
    runId: RunId,
  ) => Effect.Effect<Effect.Effect<void, Error>, Error>;
  /**
   * Write the row, awaited. A producer-supplied id is read against the run's
   * rows and appended in the same publisher job, so a delivery its producer
   * replays after a restart finds its row: `pending` when it is still
   * queued, `consumed` when a turn already carried it.
   */
  readonly write: (
    row: FollowUpQueuedDraft,
    replayable: boolean,
  ) => Effect.Effect<
    'written' | 'pending' | 'consumed',
    DatabaseNotOwner | DatabaseWriteFailed
  >;
}

/** The refusals that mean another live process holds the run. */
const heldElsewhere = (error: unknown): boolean =>
  error instanceof DatabaseNotOwner ||
  (error instanceof DatabaseWriteFailed &&
    error.cause instanceof DatabaseClaimRefused);

/**
 * Session-owned admission boundary indexed by run ID.
 *
 * An admitted follow-up is a `followup.queued` row on the run. Admission
 * decides synchronously (replay suppression, the recovery claim), then
 * writes the row, awaited, before it is acknowledged or handed to a
 * consumer: an acknowledgement means the row is durable. A run no consumer
 * here holds is claimed first, as a resume claims it. The row is the input:
 * an owned entry also hands it to its consumer's queue, and an unowned
 * run's next consumer seeds that queue from the fold.
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

  constructor(private readonly rows: FollowUpRowPort) {}

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
   *
   * Everything admission decides happens synchronously when this is called,
   * so a caller that looks up its target in the same synchronous step cannot
   * interleave with another submission; the returned effect writes the row
   * and is run at once. A run another live process holds is `refused` with
   * `owned_elsewhere`; that refusal and any write failure (which fails the
   * effect) roll the admission back, so the input can be offered again.
   */
  submit(
    runId: RunId,
    followUp: FollowUpQueueInput,
    admission: 'live_owner' | 'recoverable',
  ): Effect.Effect<FollowUpSubmission, Error> {
    if (this.disposed) return Effect.succeed({ kind: 'refused' });

    let entry = this.entries.get(runId);
    if (admission === 'live_owner') {
      if (!entry) return Effect.succeed({ kind: 'refused' });
    } else {
      if (!entry && this.terminalized.has(runId)) {
        return Effect.succeed({ kind: 'refused' });
      }
      entry ??= this.createEntry(runId);
    }

    // Replay suppression is synchronous check-and-add: concurrent submissions
    // of one delivery id admit at most once (#9531). Ids are minted per
    // logical delivery by their producer (an accepted child-run turn, an
    // inquiry turn); identical text under a distinct id is a distinct
    // delivery. The row read in `write` is the crash-safe half of the rule.
    const deliveryId = followUp.deliveryId;
    if (deliveryId !== undefined) {
      if (entry.admittedDeliveryIds.has(deliveryId)) {
        return Effect.succeed({ kind: 'duplicate' });
      }
      entry.admittedDeliveryIds.add(deliveryId);
    }

    const owner = entry.owner;
    // A live flow or child holds the run's claim for as long as it holds
    // the lease; every other admission claims the run before writing to it.
    const consumerHoldsClaim =
      owner?.kind === 'flow' || owner?.kind === 'child';
    let submission: FollowUpSubmission;
    let lease: FollowUpRecoveryLease | undefined;
    if (owner?.kind === 'flow') {
      submission = { kind: 'delivered_live' };
    } else if (owner !== undefined || admission === 'live_owner') {
      // Live notifications use the live_owner path to reach WAITING parents,
      // whose next consumer seeds its queue from the row.
      submission = { kind: 'queued' };
    } else {
      // The recovery claim precedes the row, so the input it admits is
      // already the recovering consumer's.
      lease = this.claim(entry, runId, 'recovery');
      submission = lease ? { kind: 'queued', lease } : { kind: 'queued' };
    }
    const queued: QueuedFollowUp = {
      followUpId: deliveryId ?? randomUUID(),
      content: {
        text: followUp.text,
        displayText: followUp.displayText,
        mediaFiles: followUp.mediaFiles ? [...followUp.mediaFiles] : undefined,
        origin: followUp.origin ?? 'user',
      },
    };
    const admitted = entry;
    const rollback = (): void => {
      if (deliveryId !== undefined) {
        admitted.admittedDeliveryIds.delete(deliveryId);
      }
      if (lease) this.release(lease, 'recoverable');
    };
    return this.write(runId, queued, {
      consumerHoldsClaim,
      replayable: deliveryId !== undefined,
      ownLease: lease,
    }).pipe(
      Effect.map((written): FollowUpSubmission => {
        if (written !== 'consumed') return submission;
        // A replay of a delivery a turn already carried: nothing to queue
        // and nothing to wake.
        if (lease) this.release(lease, 'recoverable');
        return { kind: 'duplicate' };
      }),
      Effect.catch((error) => {
        rollback();
        if (!heldElsewhere(error)) return Effect.fail(error);
        logger.warn(
          `Follow-up for run ${runId} was not queued: another process holds the run.`,
          { data: error },
        );
        return Effect.succeed<FollowUpSubmission>({
          kind: 'refused',
          reason: 'owned_elsewhere',
        });
      }),
      Effect.uninterruptible,
    );
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
   * Write one admitted follow-up's row, then hand it to the run's consumer.
   * A run no consumer here holds is claimed first. A claim this call took is
   * released once the write settles, unless another generation's lease holds
   * the run by then: that generation adopts the claim and ends it with its
   * own lease release. Releasing cannot pull the claim from under an
   * in-process acquirer: every one holds this boundary's lease for the run
   * first (a lease this very submission claimed launches its resume only
   * after this returns), and the lease is read in the synchronous step that
   * starts the release.
   */
  private write(
    runId: RunId,
    followUp: QueuedFollowUp,
    options: {
      readonly consumerHoldsClaim: boolean;
      readonly replayable: boolean;
      readonly ownLease: FollowUpRecoveryLease | undefined;
    },
  ): Effect.Effect<'written' | 'pending' | 'consumed', Error> {
    const rows = this.rows;
    const entries = this.entries;
    return Effect.gen(function* () {
      const release = options.consumerHoldsClaim
        ? Effect.void
        : yield* rows.acquireClaim(runId);
      const written = yield* Effect.exit(
        rows.write(
          {
            type: 'followup.queued',
            aggregateId: aggregateId('run', runId),
            ...followUp,
          },
          options.replayable,
        ),
      );
      const owner = entries.get(runId)?.owner;
      const adopted =
        Exit.isSuccess(written) &&
        owner !== undefined &&
        owner !== options.ownLease;
      if (!adopted) {
        const released = yield* Effect.exit(release);
        if (Exit.isFailure(released) && Exit.isSuccess(written)) {
          logger.warn(
            `Run ${runId}: the claim taken to queue a follow-up was not released`,
            { data: released.cause },
          );
        }
      }
      if (Exit.isFailure(written))
        return yield* Effect.failCause(written.cause);
      logger.debug(`Queued follow-up for run ${runId} (${written.value}).`);
      const entry = entries.get(runId);
      if (written.value !== 'consumed' && entry?.owner) {
        if (entry.input) entry.input.offer(followUp);
        else entry.held.push(followUp);
      }
      return written.value;
    });
  }

  private endInput(entry: QueueEntry): void {
    entry.input?.end();
    entry.input = undefined;
    entry.held = [];
  }

  private notifyReleaseObservers(runId: RunId): void {
    for (const observer of this.releaseObservers) {
      const observed = Result.try({
        try: () => observer(runId),
        catch: (err) => err,
      });
      if (Result.isFailure(observed)) {
        logger.warn(`Release observer threw for run ${runId}`, {
          data: observed.failure,
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
