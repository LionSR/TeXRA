import { randomUUID } from 'node:crypto';

import { Cause, Effect, Exit, Result } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { debug as logDebug, warn as logWarning } from '@logger/logUtils';
import type { RecoveryContinuation } from '@platform/interfaces';
import {
  aggregateId,
  type FollowUpContent,
  type RunId,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import {
  DatabaseClaimRefused,
  DatabaseNotOwner,
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from '@shared/session/database';
import type { Append } from '@shared/session/sessionEvents';
import { createBoundedIdSet } from '@utils/core/boundedIdSet';
import { ensureError } from '@utils/errors/errorMessage';
import type { QueuedFollowUp, RunInput } from './RunInput';

const CHANNEL = 'ToolUseFollowUpQueue';

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
   * row's `followUpId`, and a replay of an id the run's rows already hold
   * writes nothing; inputs without one get a minted id.
   */
  readonly deliveryId?: string;
}

type FollowUpConsumerKind = 'flow' | 'child' | 'recovery';

interface QueueEntry {
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
  /** The admission job running for this run (at most one: jobs are serial). */
  admitting: boolean;
  /** A release its owner asked for while an admission was running, applied
   *  when that admission settles. */
  pendingRelease?: 'recoverable' | 'terminal';
  /**
   * The run aggregate's database claim an admission took for a recovery
   * owner that had not launched its run yet. The recovery lease owns its
   * release: a consumer attaching to the lease adopts the claim (its own
   * run lease ends it), and a lease that exits without one releases it.
   */
  adoptedClaim?: Effect.Effect<void, Error>;
}

/**
 * Exclusive authority to consume one run's follow-up input.
 *
 * The manager issues at most one lease per entry. Claims are synchronous,
 * and a lease is valid only while it is the entry's owner, so a release from
 * an older flow/child cannot clear or terminalize a successor. Producers
 * submit through the manager and cannot manufacture a consumer.
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
 * How one submission landed, decided from the run's owner after its rows
 * committed: every follow-up a replay of a delivery a turn already carried;
 * input a live flow consumer holds this turn; input queued on the run (with
 * the recovery lease when this submission claimed it), which a consumer
 * holds or the next resume seeds from its rows; or a refusal. A refusal
 * without a reason means the boundary has no entry to join (disposed
 * session, terminalized run, or a live-owner submission to a run whose
 * entry is gone); `owned_elsewhere` means another live process holds the
 * run, so no row was written.
 */
type FollowUpSubmission =
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'delivered_live' }
  | { readonly kind: 'queued'; readonly lease?: FollowUpRecoveryLease }
  | { readonly kind: 'refused'; readonly reason?: 'owned_elsewhere' };

interface FollowUpSubmitOptions {
  /**
   * `deferred` admits the rows without offering them to a live consumer's
   * input: a child loop whose own finalize must land before the parent can
   * wake (#8093) takes this path, then re-submits the same delivery id once
   * finalization completes; the replay check finds the rows durable and
   * pending, and the offer happens then. `immediate` (the default) offers as
   * soon as the rows commit.
   */
  readonly liveOffer?: 'immediate' | 'deferred';
}

/**
 * The session doors the admission boundary works through, wired by
 * `SessionHandle` over its graph: one serializer, no second append path.
 */
interface FollowUpRowPort {
  /** One job on the session's publisher: nothing else is written, and no
   *  other job runs, while it does (`SessionGraph.exclusive`). */
  readonly exclusive: <A, E>(
    job: (append: Append) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
  /** Enqueue a job on that publisher and return (`SessionGraph.detach`). */
  readonly detach: (job: Effect.Effect<void>) => void;
  /** Every committed row of the run's aggregate. */
  readonly rows: (
    runId: RunId,
  ) => Effect.Effect<readonly SessionEvent[], DatabaseReadFailed>;
  /**
   * The run aggregate's claim, acquired the way a resume acquires it (prior
   * owners proven dead first): returns the release of what this call took,
   * a no-op when the process already held it.
   */
  readonly acquireClaim: (
    runId: RunId,
  ) => Effect.Effect<Effect.Effect<void, Error>, Error>;
}

/** The refusals that mean another live process holds the run. */
const heldElsewhere = (error: unknown): boolean =>
  error instanceof DatabaseNotOwner ||
  (error instanceof DatabaseWriteFailed &&
    error.cause instanceof DatabaseClaimRefused);

/**
 * Session-owned admission boundary indexed by run ID.
 *
 * An admitted follow-up is a `followup.queued` row on the run. One run's
 * admission is one job on the session's publisher (`exclusive`): it claims
 * the run unless a live consumer here holds it, reads the run's rows for a
 * replayed delivery id, appends every new row of the submission in one
 * transaction, and only then reads the run's owner to hand the rows over and
 * decide what the caller is told. Two admissions therefore never overlap, a
 * duplicate is judged against rows that committed, and an acknowledgement
 * means the rows are durable. A release that arrives while an admission is
 * running is applied when that admission settles, and an admission that
 * wrote rows keeps the run recoverable, so no committed row is reported to
 * a consumer that already left.
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
  static readonly TERMINALIZED_CAP = 500;
  private readonly entries = new Map<RunId, QueueEntry>();
  private readonly terminalized = createBoundedIdSet<RunId>(
    ToolUseFollowUpQueue.TERMINALIZED_CAP,
  );
  private readonly releaseObservers = new Set<(runId: RunId) => void>();
  private readonly sentObservers = new Set<(runId: RunId) => void>();
  /** Leases nobody holds that keep an entry owned while the claim an
   *  admission took for it is released ({@link releaseAdoptedClaim}). */
  private readonly releasing = new WeakSet<FollowUpConsumerLease>();
  private disposed = false;

  constructor(private readonly port: FollowUpRowPort) {}

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

  /** Claim a DB-owned child, transferring an exact recovery capability if supplied. */
  claimChildRun(
    runId: RunId,
    recovery?: FollowUpRecoveryLease,
  ): FollowUpConsumerLease | undefined {
    if (recovery) {
      if (recovery.runId !== runId || !this.useRecovery(recovery)) return;
      this.entries.get(runId)!.owner = undefined;
    }
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
    return entry?.owner === recovery &&
      recovery.kind === 'recovery' &&
      entry.pendingRelease === undefined
      ? (entry.owner as FollowUpRecoveryLease)
      : undefined;
  }

  /**
   * Submit one follow-up through the ownership boundary. `live_owner` joins
   * a live flow or child consumer, or queues without claiming when the
   * entry has no owner (so live notifications can reach a WAITING parent).
   * `recoverable` admits a registry-approved persisted run, creates its
   * entry when needed, and claims its recovery lease when no consumer holds
   * it. A run another live process holds is `refused` with
   * `owned_elsewhere`, writing nothing; any other write failure fails the
   * effect, writing nothing.
   */
  submit(
    runId: RunId,
    followUp: FollowUpQueueInput,
    admission: 'live_owner' | 'recoverable',
    options?: FollowUpSubmitOptions,
  ): Effect.Effect<FollowUpSubmission, Error> {
    return this.submitBatch(runId, [followUp], admission, options);
  }

  /**
   * Submit follow-ups as one admission: their new rows are one transaction,
   * so the batch is queued whole or not at all.
   */
  submitBatch(
    runId: RunId,
    followUps: readonly FollowUpQueueInput[],
    admission: 'live_owner' | 'recoverable',
    options?: FollowUpSubmitOptions,
  ): Effect.Effect<FollowUpSubmission, Error> {
    const queued = followUps.map((followUp): QueuedFollowUp => ({
      followUpId: followUp.deliveryId ?? randomUUID(),
      content: {
        text: followUp.text,
        displayText: followUp.displayText,
        mediaFiles: followUp.mediaFiles ? [...followUp.mediaFiles] : undefined,
        origin: followUp.origin ?? 'user',
      },
    }));
    const replayable = new Set(
      followUps.flatMap((followUp) =>
        followUp.deliveryId === undefined ? [] : [followUp.deliveryId],
      ),
    );
    // A session that has closed takes no admission: its publisher is gone.
    if (this.disposed) return Effect.succeed({ kind: 'refused' });
    return this.port.exclusive((append) =>
      this.admit(runId, queued, replayable, admission, append, options),
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
   * Attach to this lease, or to an enclosing child/recovery owner. Existing
   * input wins so every consumer of one generation reads one queue. Attachment
   * adopts the admission's claim; the caller must hold the run's DB lease.
   */
  attachInput(
    runId: RunId,
    input: RunInput,
    lease?: FollowUpConsumerLease,
  ): RunInput | undefined {
    const entry = this.entries.get(runId);
    const owner = entry?.owner;
    if (!entry || !owner || entry.pendingRelease !== undefined) {
      return undefined;
    }
    if (lease ? owner !== lease : owner.kind === 'flow') return undefined;
    entry.adoptedClaim = undefined;
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
   * forgets it. While an admission for the run is running, the release is
   * applied when that admission settles; a recovery lease that exits
   * without its run launching releases the claim an admission took for it,
   * and keeps the run owned until that release has run.
   */
  release(
    lease: FollowUpConsumerLease,
    next: 'recoverable' | 'terminal',
  ): boolean {
    const entry = this.entryForLease(lease);
    if (!entry || entry.pendingRelease !== undefined) return false;
    this.endInput(entry);
    if (entry.admitting) {
      entry.pendingRelease = next;
      return true;
    }
    this.applyRelease(lease.runId, entry, next);
    return true;
  }

  /**
   * End a run's entry: any outstanding lease becomes stale immediately, and
   * no producer can recreate the entry until an explicit claim reopens it.
   * While an admission for the run is running, the tombstone waits until
   * that job settles: a row it commits keeps the run recoverable, and a
   * refusal finishes the terminalize so nothing is left queued on a killed
   * run.
   */
  terminalize(runId: RunId): boolean {
    if (this.disposed) return false;
    const entry = this.entries.get(runId);
    if (entry?.admitting) {
      this.endInput(entry);
      entry.pendingRelease = 'terminal';
      return true;
    }
    this.finishTerminalize(runId, entry);
    return true;
  }

  /**
   * Dispose the session-owned boundary: end every attached queue, release
   * every adopted claim onto the session publisher, then drop the entry map
   * and release observers. The session's unwind settles those releases
   * before the graph closes. Entry-creating paths refuse to rebuild
   * afterwards, so a late detached producer cannot leak an entry nobody
   * will drain.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [runId, entry] of this.entries) {
      this.endInput(entry);
      this.releaseAdoptedClaim(runId, entry, () => {});
    }
    this.entries.clear();
    this.terminalized.clear();
    this.releaseObservers.clear();
  }

  /**
   * One admission, run as a job on the session's publisher. Everything that
   * reads or writes the entry after the rows commit is synchronous, so a
   * release or a claim lands before that decision or after it, never inside.
   */
  private admit(
    runId: RunId,
    followUps: readonly QueuedFollowUp[],
    replayable: ReadonlySet<string>,
    admission: 'live_owner' | 'recoverable',
    append: Append,
    options?: FollowUpSubmitOptions,
  ): Effect.Effect<FollowUpSubmission, Error> {
    return Effect.gen({ self: this }, function* (): Effect.fn.Return<
      FollowUpSubmission,
      Error
    > {
      if (this.disposed) return { kind: 'refused' };
      let entry = this.entries.get(runId);
      if (!entry) {
        if (admission === 'live_owner' || this.terminalized.has(runId)) {
          return { kind: 'refused' };
        }
        entry = this.createEntry(runId);
      }
      const admitted = entry;
      // A live flow or child holds the run's claim for as long as it holds
      // the lease; every other admission claims the run before writing.
      const consumerHoldsClaim =
        admitted.owner?.kind === 'flow' || admitted.owner?.kind === 'child';
      admitted.admitting = true;
      const written = yield* Effect.exit(
        this.writeRows(
          runId,
          followUps,
          replayable,
          consumerHoldsClaim,
          append,
        ),
      );

      // From here to the returned status, nothing yields until the claim's
      // disposition is decided.
      admitted.admitting = false;
      const pending = admitted.pendingRelease;
      if (pending !== undefined) {
        // A run that now holds rows this admission queued stays recoverable,
        // including a terminalize that arrived while the write was in flight.
        if (Exit.isSuccess(written) && written.value.wrote) {
          this.applyRelease(runId, admitted, 'recoverable');
        } else if (pending === 'terminal') {
          this.finishTerminalize(runId, admitted);
        } else {
          this.applyRelease(runId, admitted, pending);
        }
      }
      if (Exit.isFailure(written)) {
        const error = Cause.squash(written.cause);
        if (!heldElsewhere(error)) {
          return yield* Effect.fail(
            error instanceof Error
              ? error
              : new Error(`Follow-up admission failed for run ${runId}`, {
                  cause: error,
                }),
          );
        }
        yield* Effect.logWarning(
          `Follow-up for run ${runId} was not queued: another process holds the run.`,
        ).pipe(Effect.annotateLogs({ data: error }), withLogChannel(CHANNEL));
        return { kind: 'refused', reason: 'owned_elsewhere' };
      }

      const { queued, wrote, releaseClaim } = written.value;
      const current = !this.disposed && this.entries.get(runId) === admitted;
      let owner =
        current &&
        admitted.owner !== undefined &&
        !this.releasing.has(admitted.owner)
          ? admitted.owner
          : undefined;
      let lease: FollowUpRecoveryLease | undefined;
      // A deferred offer leaves a live consumer's input untouched: the caller
      // re-submits once its own ordering allows, and the offer happens then.
      const liveOfferDeferred =
        options?.liveOffer === 'deferred' &&
        (owner?.kind === 'flow' ||
          owner?.kind === 'child' ||
          (owner?.kind === 'recovery' && admitted.input !== undefined));
      if (current && queued.length > 0) {
        if (owner === undefined && admission === 'recoverable') {
          lease = this.claim(admitted, runId, 'recovery');
          owner = lease;
        }
        if (owner !== undefined && !liveOfferDeferred)
          this.offer(admitted, queued);
      }
      if (releaseClaim) {
        if (
          owner?.kind === 'recovery' &&
          queued.length > 0 &&
          admitted.adoptedClaim === undefined
        ) {
          // The recovery owner has not launched its run: the claim is its to
          // end, when a consumer adopts it or the lease exits without one.
          admitted.adoptedClaim = releaseClaim;
        } else if (owner === undefined || queued.length === 0) {
          yield* this.releaseClaim(runId, releaseClaim);
        }
        // A flow or child that claimed the run meanwhile runs it under its
        // own run lease, whose release ends the claim.
      }
      if (!current) return { kind: 'refused' };
      // Every follow-up already on the rows: a replay. One still queued for a
      // run no consumer holds was just claimed for its wake; any other replay
      // was accepted before and changes nothing.
      if (lease) return { kind: 'queued', lease };
      if (!wrote) return { kind: 'duplicate' };
      if (owner?.kind === 'flow' && !liveOfferDeferred)
        return { kind: 'delivered_live' };
      return { kind: 'queued' };
    });
  }

  /**
   * Claim the run unless a live consumer here holds it, judge replayed
   * delivery ids against the run's committed rows, and append every new row
   * in one transaction. A failure releases the claim this took.
   */
  private writeRows(
    runId: RunId,
    followUps: readonly QueuedFollowUp[],
    replayable: ReadonlySet<string>,
    consumerHoldsClaim: boolean,
    append: Append,
  ): Effect.Effect<
    {
      readonly queued: readonly QueuedFollowUp[];
      readonly wrote: boolean;
      readonly releaseClaim: Effect.Effect<void, Error> | null;
    },
    Error
  > {
    const port = this.port;
    return Effect.gen({ self: this }, function* () {
      const releaseClaim = consumerHoldsClaim
        ? null
        : yield* port.acquireClaim(runId);
      const settled = yield* Effect.exit(
        Effect.gen(function* () {
          // This job is the only admission running, so an id is judged
          // against rows that committed, never against one being written.
          const known = new Map<string, 'pending' | 'consumed'>();
          if (replayable.size > 0) {
            for (const row of yield* port.rows(runId)) {
              if (
                (row.type === 'followup.queued' ||
                  row.type === 'followup.consumed') &&
                replayable.has(row.followUpId)
              ) {
                known.set(
                  row.followUpId,
                  row.type === 'followup.consumed' ? 'consumed' : 'pending',
                );
              }
            }
          }
          const fresh = followUps.filter((f) => !known.has(f.followUpId));
          if (fresh.length > 0) {
            yield* append(
              fresh.map((followUp): SessionEventDraft => ({
                type: 'followup.queued',
                aggregateId: aggregateId('run', runId),
                ...followUp,
              })),
            );
          }
          return {
            queued: followUps.filter(
              (f) => known.get(f.followUpId) !== 'consumed',
            ),
            wrote: fresh.length > 0,
          };
        }),
      );
      if (Exit.isFailure(settled)) {
        if (releaseClaim) yield* this.releaseClaim(runId, releaseClaim);
        return yield* Effect.failCause(settled.cause);
      }
      return { ...settled.value, releaseClaim };
    });
  }

  private offer(entry: QueueEntry, followUps: readonly QueuedFollowUp[]): void {
    for (const followUp of followUps) {
      if (entry.input) entry.input.offer(followUp);
      else entry.held.push(followUp);
    }
  }

  /**
   * Tombstone the run: any outstanding lease is stale, the entry is gone,
   * and no producer can recreate it until an explicit claim reopens it.
   */
  private finishTerminalize(runId: RunId, entry: QueueEntry | undefined): void {
    if (entry) {
      this.endInput(entry);
      this.releaseAdoptedClaim(runId, entry, () => {});
    }
    this.entries.delete(runId);
    this.terminalized.add(runId);
    this.notifyReleaseObservers(runId);
  }

  private applyRelease(
    runId: RunId,
    entry: QueueEntry,
    next: 'recoverable' | 'terminal',
  ): void {
    entry.pendingRelease = undefined;
    this.endInput(entry);
    const finish = (): void => {
      entry.owner = undefined;
      if (next === 'recoverable' || this.entries.get(runId) !== entry) return;
      this.entries.delete(runId);
      logDebug(CHANNEL, `Terminalized follow-up queue for run ${runId}.`);
      this.notifyReleaseObservers(runId);
    };
    this.releaseAdoptedClaim(runId, entry, finish);
  }

  /**
   * End the claim an admission took for a recovery owner whose run never
   * launched, on the session's publisher. Until that release has run, the
   * entry stays owned (by a lease nobody holds), so no successor can claim
   * the run and acquire the database claim this release is about to drop.
   */
  private releaseAdoptedClaim(
    runId: RunId,
    entry: QueueEntry,
    finish: () => void,
  ): void {
    const claim = entry.adoptedClaim;
    entry.adoptedClaim = undefined;
    if (!claim) {
      finish();
      return;
    }
    const releasing: FollowUpConsumerLease = { runId, kind: 'recovery' };
    this.releasing.add(releasing);
    entry.owner = releasing;
    this.port.detach(
      this.releaseClaim(runId, claim).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (entry.owner === releasing) finish();
          }),
        ),
      ),
    );
  }

  private releaseClaim(
    runId: RunId,
    release: Effect.Effect<void, Error>,
  ): Effect.Effect<void> {
    return release.pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `Run ${runId}: the claim taken to queue a follow-up was not released`,
        ).pipe(Effect.annotateLogs({ data: error }), withLogChannel(CHANNEL)),
      ),
    );
  }

  private endInput(entry: QueueEntry): void {
    entry.input?.end();
    entry.input = undefined;
    entry.held = [];
  }

  private notifyReleaseObservers(runId: RunId): void {
    for (const notify of this.releaseObservers) {
      const ran = Result.try({ try: () => notify(runId), catch: ensureError });
      if (Result.isFailure(ran)) {
        logWarning(CHANNEL, `Release observer threw for run ${runId}`, {
          data: ran.failure,
        });
      }
    }
  }

  private createEntry(runId: RunId): QueueEntry {
    const entry: QueueEntry = { held: [], admitting: false };
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
