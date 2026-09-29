import { randomUUID } from 'node:crypto';

import { Cause, Effect, Exit, Result } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import {
  aggregateId,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import { heldElsewhereBy } from '@shared/session/database';
import { runRelation } from '@shared/session/runRelation';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { Append } from '@shared/session/sessionEvents';
import { ensureError } from '@utils/errors/errorMessage';
import { isInstruction } from './followUpMessages';
import { RunInput } from './RunInput';
import type { FollowUpSenderInput } from './followUpSender';
import type { FollowUpRowPort } from './followUpRowPort';

const CHANNEL = 'ToolUseFollowUpQueue';

/** The row's hold for each live offer: what releases it to a take. */
const HOLD_OF = {
  immediate: undefined,
  deferred: 'senderEnd',
  none: 'instruction',
} as const;

/** What a producer hands the admission boundary. */
export interface FollowUpQueueInput {
  readonly text: string;
  readonly displayText?: string;
  /** Media file paths (e.g. pasted images) attached to this user follow-up. */
  readonly mediaFiles?: readonly string[];
  readonly from: FollowUpSenderInput;
  /**
   * Stable logical identity of one delivery its producer may repeat: a
   * child-run result (#9531), an inquiry continuation re-delivered after a
   * decision that failed before the queue saw it. It becomes the queued
   * row's `followUpId`, and a replay of an id the run's rows already hold
   * writes nothing; inputs without one get a minted id.
   */
  readonly deliveryId?: string;
}

type FollowUpConsumerKind = 'loop' | 'child' | 'recovery';

/** The run's one consumer, and for recovery the claim hold an admission
 *  took for it, given back when a consumer adopts the run or the slot ends
 *  (`releasing` while that runs: taken, by nobody). `reserved`: the wake an
 *  admission owes the run, taken by the next resume (`claimRecovery`). */
interface Slot {
  readonly lease: FollowUpConsumerLease;
  hold?: Effect.Effect<void, Error>;
  reserved?: true;
  readonly releasing?: true;
}

interface QueueEntry {
  /** At most one; an entry with none is a recoverable persisted run. */
  slot?: Slot;
  /** The slot's input, once its consumer attached one. */
  input?: RunInput;
  /** The admission job running for this run (at most one: jobs are serial). */
  admitting: boolean;
  /** A release its owner asked for while an admission was running, applied
   *  when that admission settles. */
  pendingRelease?: 'recoverable' | 'terminal';
}

/**
 * Exclusive authority to consume one run's follow-up input.
 *
 * The manager issues at most one lease per entry. Claims are synchronous,
 * and a lease is valid only while it is the entry's owner, so a release from
 * an older loop/child cannot clear or terminalize a successor. Producers
 * submit through the manager and cannot manufacture a consumer.
 */
export interface FollowUpConsumerLease {
  readonly runId: RunId;
  readonly kind: FollowUpConsumerKind;
}

/**
 * How one submission landed, decided from the run's owner after its rows
 * committed: every follow-up a replay of a delivery a turn already carried;
 * input a running loop holds this turn; input queued on the run (`wake`: the
 * caller owes the run a resume), which a consumer holds or the next resume
 * delivers from its rows; or a refusal. A refusal without a reason: no entry
 * to join (disposed session, closed run, or a live-owner submission with no
 * entry); `owned_elsewhere`: another live process holds the run, and no row
 * was written.
 */
type FollowUpSubmission =
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'delivered_live' }
  | { readonly kind: 'queued'; readonly wake?: true }
  | { readonly kind: 'refused'; readonly reason?: 'owned_elsewhere' };

interface FollowUpSubmitOptions {
  /**
   * `immediate` (the default) offers as soon as the rows commit. `deferred`
   * holds them on the row until their sending run has ended (#8093: a
   * finalizing child's result, re-submitted after its finalize). `none`
   * holds them until a take also carries an instruction.
   */
  readonly liveOffer?: 'immediate' | 'deferred' | 'none';
}

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
 * A run whose input is closed (`followup.closed`, `run.removed`: the rows,
 * across processes) refuses a producer that is not a claim, such as a child
 * outliving its parent's teardown; a claim or its next activation reopens.
 */
export class ToolUseFollowUpQueue {
  private readonly entries = new Map<RunId, QueueEntry>();
  private readonly releaseObservers = new Set<(runId: RunId) => void>();
  private disposed = false;
  /** Log on the session's publisher: release paths also run off-fiber. */
  private readonly log = (entry: Effect.Effect<void>): void =>
    this.port.detach(() => entry.pipe(withLogChannel(CHANNEL)));

  constructor(private readonly port: FollowUpRowPort) {}

  onRelease(observer: (runId: RunId) => void): () => void {
    if (this.disposed) return () => {};
    this.releaseObservers.add(observer);
    return () => {
      this.releaseObservers.delete(observer);
    };
  }

  /** Claim a running loop or child consumer. A competing owner is rejected. */
  claimLive(
    runId: RunId,
    kind: Exclude<FollowUpConsumerKind, 'recovery'>,
  ): FollowUpConsumerLease | undefined {
    if (this.disposed) return undefined;
    const entry = this.entries.get(runId) ?? this.createEntry(runId);
    return this.claim(entry, runId, kind);
  }

  /** Claim a DB-owned child, transferring an exact recovery capability if supplied. */
  claimChildRun(
    runId: RunId,
    recovery?: FollowUpConsumerLease,
  ): FollowUpConsumerLease | undefined {
    if (!recovery) return this.claimLive(runId, 'child');
    if (recovery.runId !== runId || !this.useRecovery(recovery)) return;
    const entry = this.entries.get(runId)!;
    const lease: FollowUpConsumerLease = { runId, kind: 'child' };
    entry.slot = { lease, hold: entry.slot?.hold }; // the hold carries over
    return lease;
  }

  /** Claim persisted recovery before any asynchronous resume preparation:
   *  the reserved wake, or a fresh claim when no consumer holds the run. */
  claimRecovery(
    runId: RunId,
    createIfMissing = false,
  ): FollowUpConsumerLease | undefined {
    if (this.disposed) return undefined;
    const entry =
      this.entries.get(runId) ??
      (createIfMissing ? this.createEntry(runId) : undefined);
    const slot = entry?.slot;
    if (entry && !slot) return this.claim(entry, runId, 'recovery');
    if (!slot?.reserved || entry!.pendingRelease !== undefined) return;
    slot.reserved = undefined;
    return slot.lease;
  }

  useRecovery(
    recovery: FollowUpConsumerLease,
  ): FollowUpConsumerLease | undefined {
    const entry = this.entries.get(recovery.runId);
    return entry?.slot?.lease === recovery &&
      recovery.kind === 'recovery' &&
      entry.pendingRelease === undefined
      ? recovery
      : undefined;
  }

  /**
   * Submit one follow-up through the ownership boundary. `live_owner` joins
   * a running loop or child consumer, or queues without claiming when the
   * entry has no owner (so live notifications can reach a WAITING parent).
   * `recoverable` admits a registry-approved persisted run, creates its
   * entry when needed, and reserves its recovery (`wake`) when no consumer
   * holds it. A run another live process holds is `refused` with
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
    const replayable = new Set(
      followUps.flatMap((followUp) =>
        followUp.deliveryId === undefined ? [] : [followUp.deliveryId],
      ),
    );
    // A session that has closed takes no admission: its publisher is gone.
    if (this.disposed) return Effect.succeed({ kind: 'refused' });
    return this.port.exclusive((append) =>
      this.admit(runId, followUps, replayable, admission, append, options),
    );
  }

  /** Read-only lifecycle probe used by diagnostics and teardown assertions. */
  hasLiveOwner(runId: RunId): boolean {
    const kind = this.entries.get(runId)?.slot?.lease.kind;
    return kind === 'loop' || kind === 'child';
  }

  /**
   * Attach to this lease, or to an enclosing child/recovery owner. Existing
   * input wins so every consumer of one generation reads one input.
   * The caller holds the run's claim already, so the slot's hold is given
   * back: a consumer's own hold is the claim's now.
   */
  attachInput(
    runId: RunId,
    lease?: FollowUpConsumerLease,
  ): RunInput | undefined {
    const entry = this.entries.get(runId);
    const slot = entry?.slot;
    if (!entry || !slot || slot.releasing || entry.pendingRelease !== undefined)
      return undefined;
    if (lease ? slot.lease !== lease : slot.lease.kind === 'loop')
      return undefined;
    const hold = slot.hold;
    slot.hold = undefined;
    if (hold) this.port.detach(() => this.releaseClaim(runId, hold));
    entry.input ??= new RunInput(() => this.takeable(runId));
    return entry.input;
  }

  /**
   * Release the entry `lease` owns, if it still does. Its input ends either
   * way: queued rows stay on the run for the next consumer. `recoverable`
   * keeps the entry for a successor claim; `terminal` forgets it. While an
   * admission is running the release waits for it to settle.
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
   * Close a run's input with a `followup.closed` row. While an admission is
   * running the close waits for it: a row it commits keeps the run
   * recoverable. A deleted run is {@link forget}: `run.removed` closes it.
   */
  terminalize(runId: RunId): boolean {
    if (this.disposed) return false;
    const entry = this.entries.get(runId);
    if (entry?.admitting) {
      this.endInput(entry);
      entry.pendingRelease = 'terminal';
      return true;
    }
    this.finishTerminalize(runId);
    return true;
  }

  /** Drop a deleted run's entry: its `run.removed` row closes its input. */
  forget(runId: RunId): void {
    if (this.disposed) return;
    const entry = this.entries.get(runId);
    if (entry) {
      this.endInput(entry);
      this.releaseSlotHold(runId, entry, () => {});
    }
    this.entries.delete(runId);
    this.notifyReleaseObservers(runId);
  }

  /** What a take may hold: no row whose sender has not ended, and an
   *  `instruction`-held row only beside an unheld instruction. */
  private takeable(runId: RunId): readonly QueuedFollowUp[] {
    const rows = this.port
      .pending(runId)
      .filter(
        ({ holdUntil, content }) =>
          holdUntil !== 'senderEnd' ||
          content.from.kind !== 'run' ||
          this.port.ended(content.from.runId),
      );
    const asked = rows.some(
      (f) => f.holdUntil !== 'instruction' && isInstruction(f.content),
    );
    return asked ? rows : rows.filter((f) => f.holdUntil !== 'instruction');
  }

  /** A run's terminal row folded (any process): its held rows may be
   *  takeable now, so every waiting take looks again. */
  wakeTakes(): void {
    for (const entry of this.entries.values()) entry.input?.notify();
  }

  /** Consume, with no turn, the run's pending deliveries from `childRunId`
   *  (`turnDeliveryId`): the run already took the result another way (a wait
   *  that returned it). One publisher job, so no admission interleaves. */
  withdraw(
    runId: RunId | undefined,
    childRunId: RunId,
  ): Effect.Effect<number, Error> {
    if (runId === undefined || this.disposed) return Effect.succeed(0);
    return this.port.exclusive((append) => {
      const withdrawn = this.port
        .pending(runId)
        .filter(({ followUpId }) => followUpId.startsWith(`${childRunId}:`));
      const rows = withdrawn.map(({ followUpId }): SessionEventDraft => ({
        type: 'followup.consumed',
        aggregateId: aggregateId('run', runId),
        followUpId,
      }));
      return Effect.as(
        rows.length > 0 ? append(rows) : Effect.void,
        rows.length,
      );
    });
  }

  /** End every input, give back every slot hold on the publisher (the
   *  session's last finalizer settles them), and report each run released. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [runId, entry] of this.entries) {
      this.endInput(entry);
      this.releaseSlotHold(runId, entry, () => {});
      this.notifyReleaseObservers(runId);
    }
    this.entries.clear();
    this.releaseObservers.clear();
  }

  /**
   * One admission, run as a job on the session's publisher. Everything that
   * reads or writes the entry after the rows commit is synchronous, so a
   * release or a claim lands before that decision or after it, never inside.
   */
  private admit(
    runId: RunId,
    followUps: readonly FollowUpQueueInput[],
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
      const found = this.entries.get(runId);
      // A run no slot here holds answers "closed" from its rows, not from
      // memory: asked again once this admission holds its claim.
      const closed = () => !found?.slot && this.port.inputClosed(runId);
      if ((!found && admission === 'live_owner') || closed())
        return { kind: 'refused' };
      const admitted = found ?? this.createEntry(runId);
      // A running loop or child holds the run's claim for as long as it holds
      // the lease; every other admission claims the run before writing.
      const holder = admitted.slot?.lease.kind;
      const consumerHoldsClaim = holder === 'loop' || holder === 'child';
      // Stamped inside the admission job, so the parentage a run sender's
      // relation to the recipient is read from is committed state.
      const holdUntil = HOLD_OF[options?.liveOffer ?? 'immediate'];
      const stamped = followUps.map(({ from, ...input }): QueuedFollowUp => ({
        followUpId: input.deliveryId ?? randomUUID(),
        ...(holdUntil ? { holdUntil } : {}),
        content: {
          text: input.text,
          displayText: input.displayText,
          mediaFiles: input.mediaFiles ? [...input.mediaFiles] : undefined,
          from:
            from.kind === 'run'
              ? {
                  kind: 'run',
                  runId: from.runId,
                  relation: runRelation(from.runId, runId, this.port.parentOf),
                }
              : from,
        },
      }));
      admitted.admitting = true;
      const written = yield* Effect.exit(
        this.writeRows(
          runId,
          stamped,
          replayable,
          consumerHoldsClaim,
          closed,
          append,
        ),
      );

      // Nothing yields from here until the claim's disposition is decided.
      admitted.admitting = false;
      const pending = admitted.pendingRelease;
      if (pending !== undefined) {
        // A run that now holds rows this admission queued stays recoverable,
        // including a terminalize that arrived while the write was in flight.
        const value = Exit.isSuccess(written) ? written.value : 'closed';
        if (value !== 'closed' && value.wrote) {
          this.applyRelease(runId, admitted, 'recoverable');
        } else if (pending === 'terminal') {
          this.finishTerminalize(runId);
        } else {
          this.applyRelease(runId, admitted, pending);
        }
      }
      if (Exit.isFailure(written)) {
        const error = Cause.squash(written.cause);
        if (heldElsewhereBy(error) === null) {
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

      if (written.value === 'closed') {
        if (this.entries.get(runId) === admitted && !admitted.slot)
          this.entries.delete(runId);
        return { kind: 'refused' };
      }
      const { queued, wrote, releaseClaim } = written.value;
      const current = !this.disposed && this.entries.get(runId) === admitted;
      const slot = current ? admitted.slot : undefined;
      let owner = slot && !slot.releasing ? slot.lease : undefined;
      let wake = false;
      // A deferred offer holds the rows back from a live consumer's input:
      // the caller re-submits once its own ordering allows, and the offer
      // happens then.
      const liveConsumer =
        owner?.kind === 'loop' ||
        owner?.kind === 'child' ||
        (owner?.kind === 'recovery' && admitted.input !== undefined);
      const liveOfferDeferred =
        options?.liveOffer === 'deferred' && liveConsumer;
      if (current && queued.length > 0) {
        // `none` offers nothing to wake: its row waits for the next input.
        if (
          owner === undefined &&
          admission === 'recoverable' &&
          options?.liveOffer !== 'none'
        ) {
          owner = this.claim(admitted, runId, 'recovery');
          if (owner) admitted.slot!.reserved = wake = true;
        }
        // A held row is offered by what releases it (`wakeTakes`, ...).
        if (owner !== undefined && holdUntil === undefined)
          admitted.input?.notify();
      }
      if (releaseClaim) {
        const recovery = admitted.slot;
        if (
          owner?.kind === 'recovery' &&
          recovery !== undefined &&
          queued.length > 0 &&
          recovery.hold === undefined
        ) {
          recovery.hold = releaseClaim;
        } else {
          // Every other hold this admission took is given back now: no owner
          // needs it, a loop or child that claimed the run meanwhile holds
          // the claim itself, and a recovery owner already keeps one.
          yield* this.releaseClaim(runId, releaseClaim);
        }
      }
      if (!current) return { kind: 'refused' };
      // Every follow-up already on the rows: a replay, news only if it
      // just reserved the wake.
      if (wake) return { kind: 'queued', wake };
      if (!wrote) return { kind: 'duplicate' };
      if (owner?.kind === 'loop' && !liveOfferDeferred)
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
    closed: () => boolean,
    append: Append,
  ): Effect.Effect<
    | 'closed'
    | {
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
      // Closed elsewhere: the claim's hydrate read it when the claim moved.
      if (closed()) {
        if (releaseClaim) yield* this.releaseClaim(runId, releaseClaim);
        return 'closed' as const;
      }
      const settled = yield* Effect.exit(
        Effect.gen(function* () {
          // The only admission running: a replayed id is judged against the
          // committed follow-up slice the publisher keeps whole under the
          // claim, not written again, and queued unless the rows consumed it.
          const replayed = new Set(
            followUps.flatMap(({ followUpId }) =>
              replayable.has(followUpId) && port.named(runId, followUpId)
                ? [followUpId]
                : [],
            ),
          );
          const pending =
            replayed.size === 0
              ? new Set<string>()
              : new Set(port.pending(runId).map((f) => f.followUpId));
          const fresh = followUps.filter((f) => !replayed.has(f.followUpId));
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
              ({ followUpId }) =>
                !replayed.has(followUpId) || pending.has(followUpId),
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

  /** Forget the run and write its `followup.closed` under its claim, in
   *  one publisher job that gives the slot's hold back only after. */
  private finishTerminalize(runId: RunId): void {
    const slot = this.entries.get(runId)?.slot;
    const hold = slot?.hold;
    if (slot) slot.hold = undefined;
    this.forget(runId);
    const run = aggregateId('run', runId);
    this.port.detach((append) =>
      Effect.flatMap(this.port.acquireClaim(runId), (release) =>
        append([{ type: 'followup.closed', aggregateId: run }]).pipe(
          Effect.ensuring(this.releaseClaim(runId, release)),
        ),
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Run ${runId}: its closed input was not recorded`,
          ).pipe(Effect.annotateLogs({ data: error }), withLogChannel(CHANNEL)),
        ),
        Effect.ensuring(hold ? this.releaseClaim(runId, hold) : Effect.void),
      ),
    );
  }

  private applyRelease(
    runId: RunId,
    entry: QueueEntry,
    next: 'recoverable' | 'terminal',
  ): void {
    entry.pendingRelease = undefined;
    this.endInput(entry);
    const finish = (): void => {
      entry.slot = undefined;
      if (next === 'recoverable' || this.entries.get(runId) !== entry) return;
      this.entries.delete(runId);
      const ended = `Terminalized follow-up queue for run ${runId}.`;
      this.log(Effect.logDebug(ended));
      this.notifyReleaseObservers(runId);
    };
    this.releaseSlotHold(runId, entry, finish);
  }

  /**
   * Give back the slot's hold on the publisher; until then the slot stays
   * taken, by nobody, so no successor acquires a claim about to drop.
   */
  private releaseSlotHold(
    runId: RunId,
    entry: QueueEntry,
    finish: () => void,
  ): void {
    const hold = entry.slot?.hold;
    if (!hold) return finish();
    const releasing: Slot = {
      lease: { runId, kind: 'recovery' },
      releasing: true,
    };
    entry.slot = releasing;
    this.port.detach(() =>
      this.releaseClaim(runId, hold).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (entry.slot === releasing) finish();
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
  }

  private notifyReleaseObservers(runId: RunId): void {
    for (const notify of this.releaseObservers) {
      const ran = Result.try({ try: () => notify(runId), catch: ensureError });
      if (Result.isFailure(ran)) {
        const threw = `Release observer threw for run ${runId}`;
        const failure = { data: ran.failure };
        this.log(Effect.logWarning(threw).pipe(Effect.annotateLogs(failure)));
      }
    }
  }

  private createEntry(runId: RunId): QueueEntry {
    const entry: QueueEntry = { admitting: false };
    this.entries.set(runId, entry);
    return entry;
  }

  /** Mint the entry's single lease. */
  private claim(
    entry: QueueEntry,
    runId: RunId,
    kind: FollowUpConsumerKind,
  ): FollowUpConsumerLease | undefined {
    if (entry.slot) return undefined;
    const lease: FollowUpConsumerLease = { runId, kind };
    entry.slot = { lease };
    return lease;
  }

  /** The entry `lease` still owns, or `undefined` if it has gone stale. */
  private entryForLease(lease: FollowUpConsumerLease): QueueEntry | undefined {
    const entry = this.entries.get(lease.runId);
    return entry?.slot?.lease === lease ? entry : undefined;
  }
}
