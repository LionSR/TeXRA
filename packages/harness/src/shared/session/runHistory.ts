/**
 * The run history: the only reader of run-history-private payloads and the only
 * writer of the run rows. Three operations, each a boundary the row design
 * names, each taking the run id and qualifying its own aggregate access with
 * `aggregateId('run', run)`.
 *
 * Stateless by construction. The loop holds the `RunState`; the run history folds
 * the batch it just committed onto the state it was handed. That is what
 * makes `foldRunState` provably the same function on the live path and on
 * resume, and it keeps a session-root service free of per-run mutable cache.
 *
 * Deliberately absent: no `append` (a one-row case is a one-element batch),
 * no `messages()` (the folded state holds them), no snapshot writer helper
 * (a snapshot is a row like any other), no subscribe surface.
 */
import { Cause, Context, Data, type Effect } from 'effect';

import type { RunId, SessionEvent, SessionEventDraft } from '@shared/schemas';
import { type DatabaseReadFailed, DatabaseWriteFailed } from './database';
import type {
  RunHistoryDraft,
  RunHistoryInconsistent,
  RunState,
} from './runStateFold';

/**
 * A refusal the run history itself decided. Database failures are NOT folded into
 * this type: reporting a disk error as a stolen claim is the silent-
 * degradation defect in a different costume, so `acquire` and `load` keep
 * them in their error channel beside it.
 *
 * Which arms are reachable, and from where (D6 b):
 * - `not-owner`: from `acquire`, where `Database.acquireClaims` proves prior
 *   owners dead before moving the claim and a live foreign owner is the
 *   `DatabaseClaimRefused` verdict it fails with (a claim taken after that
 *   proof is `DatabaseNotOwner`); and from `appendBatch`,
 *   where `SessionEvents.publish` refuses a target this process no longer
 *   holds open as `DatabaseNotOwner`, nothing written. It is never
 *   synthesised from any other write failure: a disk error stays a
 *   `DatabaseWriteFailed` (F3). A loop that meets it mid-turn stops with it,
 *   no retry and no second write (R7).
 * - `unsafe-endpoint`: a pre-publish assertion over every durable origin,
 *   the loud restatement of the package's endpoint constraint (D1).
 * - `unprepared-history`: `PreparedHistorySchema` over the history the batch
 *   assembles, at the write boundary of every batch that appends to or
 *   rewrites it, and on cold load (D11).
 * - `inconsistent`: the rows do not fold; `cause` says why. From `load`, and
 *   from `appendBatch` before it publishes: a batch is folded first and
 *   refused with nothing committed, because a published row the fold rejects
 *   is a run no later `load` can read.
 * A violated `appendBatch` precondition is a caller defect (`Effect.die`),
 * not an arm: the loop must not handle it.
 */
export class RunHistoryRefused extends Data.TaggedError('RunHistoryRefused')<{
  readonly reason:
    'not-owner' | 'unsafe-endpoint' | 'unprepared-history' | 'inconsistent';
  readonly runId: RunId;
  readonly detail: string;
  readonly cause?: RunHistoryInconsistent;
}> {
  override get message(): string {
    return `The run history refused a write (${this.reason}): ${this.detail}`;
  }
}

/**
 * The store's refusal anywhere in `cause`, failure or defect. A refused write
 * ends the run whatever failed beside it, so a caller that turns the rest of
 * a cause into a result must look past the first reason `Cause.squash` picks.
 */
export function findStorageRefusal(
  cause: Cause.Cause<unknown>,
): DatabaseWriteFailed | RunHistoryRefused | undefined {
  for (const reason of cause.reasons) {
    if (Cause.isInterruptReason(reason)) continue;
    const error = Cause.isFailReason(reason) ? reason.error : reason.defect;
    if (
      error instanceof DatabaseWriteFailed ||
      error instanceof RunHistoryRefused
    )
      return error;
  }
  return undefined;
}

export class RunHistory extends Context.Service<
  RunHistory,
  {
    /**
     * The claim gate, called before any resume side effect: resume acquires
     * the run aggregate's current claim first, and continues from the state
     * it answers, `load`'s answer from the same read. Without it a second
     * process can fold a run's state, re-dispatch a barrier tool, and learn
     * only at its first append that the claim never moved, after the side
     * effect.
     */
    readonly acquire: (
      run: RunId,
    ) => Effect.Effect<
      RunState | null,
      RunHistoryRefused | DatabaseReadFailed | DatabaseWriteFailed
    >;
    /**
     * Fold a run's rows into its state. `null` only when no run history row has
     * folded: the loop's fresh-run branch and, for a run recorded before the
     * run history, the honest answer, distinct from "checkpoint corrupt".
     * Queued follow-ups alone still return that unopened state (`phase` is
     * null) so the caller can deliver them; they do not open the run. Run history
     * rows without an opening `run.snapshot` are not that case: they are a
     * malformed aggregate and fail `inconsistent`, because folding an
     * `attempt` or a `response` into a fresh run is how a paid invocation
     * gets issued twice. Reads the run aggregate in full: a `run.snapshot`
     * carries no reference to the message history below it (D5 dropped
     * `messageBaseCommit`), so a fold anchored at the latest snapshot would
     * restore a run with no conversation and no error to say so.
     */
    readonly load: (
      run: RunId,
      /** Fold only the rows up to this `seq`: the run as it stood there. */
      through?: number,
    ) => Effect.Effect<RunState | null, RunHistoryRefused | DatabaseReadFailed>;
    /**
     * The latest `run.snapshot` on the run aggregate, one indexed row read
     * and no fold: what every reader of the retired `flow_<id>.json` becomes.
     * `null` when the run has never written one, or is closed. Existence,
     * `payload.family`, and `payload.runtime` (model id, backend,
     * last error, declined routes) are the facts it answers; a run's
     * position and state are `load`.
     */
    readonly latestSnapshot: (
      run: RunId,
    ) => Effect.Effect<
      Extract<SessionEvent, { type: 'run.snapshot' }> | null,
      DatabaseReadFailed
    >;
    /**
     * Commit one ordered batch in one transaction, and return the state the
     * loop continues from: `state` folded with the rows the publisher
     * actually committed. Failure of any member commits none.
     *
     * Preconditions, checked before publish; a violation is a defect:
     * - a `run.snapshot` is the last run history row of its batch, except when a
     *   `run.position`, a companion `tool.end`, a `request.decided`, or the
     *   stream.end` closing the row a `waiting` step parks beside follows
     *   it. A `request.opened` PRECEDES the `tool.binding` or `model.retry`
     *   that binds it, so the fold resolves the binding against a request
     *   it already holds;
     * - a `context.edit` immediately precedes the `model.message`
     *   `response` row that used it, when both are present;
     * - a `model.message` `response` row carries the dispatch facts and the
     *   priced `usage` of its turn, both stamped here: the package produces
     *   neither dispatch facts nor a price, and `RunState.usage` is
     *   derived from the rows alone (D12), so a row appended without its
     *   `NormalizedUsage` silently loses that turn's cost on resume;
     * - a `model.message` `append` naming `sourceResponse` requires that
     *   response to be the current pending response, and its first message
     *   to be a tool group carrying, at the `callOrdinal` of each of that
     *   response's dispatch facts, the committed settlement for that
     *   `callId` (committed before, or earlier in this batch). This is the
     *   settlement-to-provider join: the canonical tool message binds
     *   results to calls positionally, the run history keys them by `callId`.
     * - `registration`, the rows that register the run this batch opens
     *   (`run.start` first), comes only with a null `state`: they commit
     *   ahead of `rows` in the same transaction, so no crash leaves the run
     *   registered without the history it was registered with. The claim
     *   the birth takes is released once the batch commits: such a run is
     *   its host's to resume.
     */
    readonly appendBatch: (
      run: RunId,
      state: RunState | null,
      rows: readonly RunHistoryDraft[],
      registration?: readonly SessionEventDraft[],
    ) => Effect.Effect<RunState, RunHistoryRefused | DatabaseWriteFailed>;
  }
>()('@texra/session/RunHistory') {}
