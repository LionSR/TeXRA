/**
 * The run history: the only reader of run-history-private payloads and the
 * only writer of the rows a run's state is folded from, each through one
 * run's {@link RunCell}. Two operations: `load` reads, `open` hands out the
 * cell every write of the run goes through.
 *
 * Stateless by construction. A cell holds its run's `RunState`, folded from
 * the batches it commits; that is what makes `foldRunState` provably the
 * same function on the live path and on resume, and it keeps a session-root
 * service free of per-run mutable cache.
 */
import { Cause, Context, Data, type Effect, type Scope } from 'effect';

import type { RunId, SessionEventDraft } from '@shared/schemas';
import { type DatabaseReadFailed, DatabaseWriteFailed } from './database';
import type { Append, CoWrite } from './sessionEvents';
import type {
  RunHistoryDraft,
  RunHistoryInconsistent,
  RunState,
} from './runStateFold';

/**
 * A refusal the run history itself decided. Database failures are NOT folded into
 * this type: reporting a disk error as a stolen claim is the silent-
 * degradation defect in a different costume, so `open` and `load` keep
 * them in their error channel beside it.
 *
 * Which arms are reachable, and from where (D6 b):
 * - `not-owner`: from a resume's `open`, where the claim proves prior owners
 *   dead before moving and a live foreign owner is the
 *   `DatabaseClaimRefused` verdict it fails with (a claim taken after that
 *   proof is `DatabaseNotOwner`); and from `RunCell.append`,
 *   where the session's log refuses a target this process no longer
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
 *   from `RunCell.append` before it publishes: a batch is folded first and
 *   refused with nothing committed, because a published row the fold rejects
 *   is a run no later `load` can read.
 * A violated `RunCell.append` precondition is a caller defect
 * (`Effect.die`), not an arm: the loop must not handle it.
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

/** What a run cell's commits and re-reads fail with. */
export type CellError =
  RunHistoryRefused | DatabaseWriteFailed | DatabaseReadFailed;

/**
 * One run's state holder and the only writer of the rows its state is
 * folded from: the opening, every step, settlement and delivery, the input
 * it consumes, a compaction's edit, a model switch and its end all commit
 * through {@link RunCell.append}, and nothing sets the state it holds but
 * what that folds back. The loop hands the same cell to the invoker and the
 * dispatch unit, so no run service keeps a copy of the state it commits
 * against.
 */
export interface RunCell {
  readonly runId: RunId;
  /** The state the run continues from. Nothing mirrors it. */
  readonly current: Effect.Effect<RunState>;
  /** The state the cell opened on: what a resume folded from stored rows,
   *  or a fresh run's before its opening batch. */
  readonly opened: RunState;
  /**
   * Commit one batch against the current state and hold what the fold gives
   * back. Rows that read the state (a step, a settlement, a delivery) are
   * built from the state the batch commits against. Read-append-write is
   * one uninterruptible region under the cell's lock, the wait for the lock
   * included: a settlement queued behind a sibling when the run stops
   * belongs to a tool that already ran, and committing it keeps a resume
   * from running it again. `alongside` decides another aggregate's rows,
   * appended after the batch's in its one append: a child turn's delivery
   * to its parent. Failure of any member commits none.
   *
   * Preconditions, checked before anything is written; a violation is a
   * defect:
   * - a batch on an unopened run carries the `run.position` that opens it,
   *   unless it is empty (a registration alone) or carries the run's end;
   * - a `request.opened` precedes the `failed` attempt that asks it;
   * - a `context.edit` immediately precedes the `model.message` `response`
   *   row that used it, when both are present;
   * - a `model.message` `append` naming `sourceResponse` requires that
   *   response to be the pending one, and its first message to be a tool
   *   group carrying, at each call's ordinal, that call's committed
   *   settlement (committed before, or earlier in this batch): the canonical
   *   tool message binds results to calls positionally, the run history
   *   keys them by `callId`.
   */
  readonly append: <E = never>(
    rows:
      | readonly RunHistoryDraft[]
      | ((state: RunState) => readonly RunHistoryDraft[]),
    alongside?: Effect.Effect<CoWrite, E, Scope.Scope>,
  ) => Effect.Effect<RunState, RunHistoryRefused | DatabaseWriteFailed | E>;
  /**
   * Re-read the run under the cell's lock: the state with every row another
   * writer committed (a `request.decided` a surface landed), in commit
   * order, whatever this cell appended since. Folding one such row onto the
   * cell instead cannot work once a sibling call's settlement has committed
   * after it.
   */
  readonly refresh: Effect.Effect<
    RunState,
    RunHistoryRefused | DatabaseReadFailed
  >;
}

/** How {@link RunHistory} opens a cell. */
export interface RunOpening<E = never> {
  /**
   * A new run's registration (`run.start` first): it rides the cell's
   * first append, so the run exists with what that append writes or not at
   * all. The birth takes the run's claim for this process.
   */
  readonly registration?: readonly SessionEventDraft[];
  /**
   * A resume: take the run's claim (proving a prior owner dead) and commit,
   * in one batch, the cancellation of every request the previous owner left
   * unbound and the rows this decides from the stored state (its
   * `run.activate`, the grants it ends, a changed configuration).
   */
  readonly activation?: (
    state: RunState | null,
  ) => Effect.Effect<readonly SessionEventDraft[], E>;
  /**
   * The publisher job the caller is inside: the cell folds the run's rows
   * in that job and appends through its transaction, never a nested one,
   * and takes no claim, so the job's other rows and the cell's commit
   * together.
   */
  readonly within?: Append;
}

/** The run history over one session's log. */
export class RunHistory extends Context.Service<
  RunHistory,
  {
    /**
     * Fold a run's rows into its state. `null` only when no run history row
     * has folded. Queued follow-ups alone still return that unopened state
     * (`phase` is null); they do not open the run. Run history rows without
     * an opening `run.position` are a malformed aggregate and fail
     * `inconsistent`, because folding an `attempt` or a `response` into a
     * fresh run is how a paid invocation gets issued twice. Reads the run
     * aggregate in full: the state is the fold of every row.
     */
    readonly load: (
      run: RunId,
      /** Fold only the rows up to this `seq`: the run as it stood there. */
      through?: number,
    ) => Effect.Effect<RunState | null, RunHistoryRefused | DatabaseReadFailed>;
    /**
     * The run's cell, seeded with its stored state (a fresh state when it
     * has none). A resume (`activation`) is the claim gate, taken before any
     * resume side effect: a second process learns it never had the run
     * before it re-dispatches anything.
     */
    readonly open: <E = never>(
      run: RunId,
      opening?: RunOpening<E>,
    ) => Effect.Effect<
      RunCell,
      RunHistoryRefused | DatabaseReadFailed | DatabaseWriteFailed | E
    >;
  }
>()('@texra/session/RunHistory') {}
